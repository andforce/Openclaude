import type { ConnectedProviderInfo, GlobalConfig } from './config.js'

// Multiple "Custom OpenAI-compatible" endpoints can be connected at once. The
// first one keeps the legacy bare id `custom-openai` (and the legacy
// `custom-openai:<model>` model value) for backward compatibility; every
// additional endpoint gets a slug-scoped id `custom-openai:<host-slug>` and a
// provider-qualified model value `openai-compatible:<providerId>:<model>`.
// Mirrors customAnthropicProviders.ts.

export const CUSTOM_OPENAI_PROVIDER_ID = 'custom-openai'
export const CUSTOM_OPENAI_PROVIDER_PREFIX = 'custom-openai:'
export const OPENAI_COMPATIBLE_MODEL_PREFIX = 'openai-compatible:'

type ModelCache = Array<{ id: string }>

export type OpenAICompatibleModelRef = {
  providerId: string
  modelId: string
}

export function isCustomOpenAIProviderId(
  providerId: string | undefined,
): providerId is string {
  return (
    providerId === CUSTOM_OPENAI_PROVIDER_ID ||
    providerId?.startsWith(CUSTOM_OPENAI_PROVIDER_PREFIX) === true
  )
}

export function normalizeCustomOpenAIBaseUrl(baseUrl: string): string {
  // Trim trailing slashes and a trailing `/v1`: `chatCompletionsUrl()` resolves
  // `https://host` and `https://host/v1` to the same endpoint, so they must
  // dedup to one provider. Mirrors normalizeCustomAnthropicBaseUrl.
  let root = baseUrl.trim().replace(/\/+$/, '')
  if (root.endsWith('/v1')) {
    root = root.slice(0, -3)
  }
  return root
}

function slugifyBaseUrl(baseUrl: string): string {
  const normalized = normalizeCustomOpenAIBaseUrl(baseUrl)

  try {
    const url = new URL(normalized)
    const host = url.host.replace(/:/g, '-')
    const path = url.pathname.split('/').filter(Boolean).join('-')
    return sanitizeSlug(path ? `${host}-${path}` : host)
  } catch {
    return sanitizeSlug(normalized)
  }
}

function sanitizeSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'endpoint'
  )
}

export function getCustomOpenAIProviderById(
  config: GlobalConfig,
  providerId: string | undefined = config.activeProvider,
): ConnectedProviderInfo | undefined {
  if (!isCustomOpenAIProviderId(providerId)) {
    return undefined
  }
  return config.connectedProviders?.[providerId]
}

export function getCustomOpenAIModels(
  config: GlobalConfig,
  providerId: string | undefined = config.activeProvider,
): ModelCache | undefined {
  if (!isCustomOpenAIProviderId(providerId)) {
    return undefined
  }

  const scopedCache = config.openaiCustomModelsCaches?.[providerId]
  if (scopedCache) {
    return scopedCache
  }

  if (providerId === CUSTOM_OPENAI_PROVIDER_ID) {
    return config.openaiCustomModelsCache
  }

  return undefined
}

/**
 * Resolve the provider id to store a newly connected endpoint under. Reuses an
 * existing custom-openai provider with the same base URL; otherwise uses the
 * bare `custom-openai` id for the first endpoint, then slug-scoped ids.
 */
export function resolveCustomOpenAIProviderId(
  config: GlobalConfig,
  baseUrl: string,
): string {
  const normalizedBaseUrl = normalizeCustomOpenAIBaseUrl(baseUrl)
  const connectedProviders = config.connectedProviders ?? {}

  for (const [providerId, provider] of Object.entries(connectedProviders)) {
    if (
      isCustomOpenAIProviderId(providerId) &&
      provider.baseUrl &&
      normalizeCustomOpenAIBaseUrl(provider.baseUrl) === normalizedBaseUrl
    ) {
      return providerId
    }
  }

  // First custom-openai endpoint keeps the legacy bare id for back-compat with
  // existing model values (`custom-openai:<model>`) and routing.
  if (!(CUSTOM_OPENAI_PROVIDER_ID in connectedProviders)) {
    return CUSTOM_OPENAI_PROVIDER_ID
  }

  const baseProviderId = `${CUSTOM_OPENAI_PROVIDER_PREFIX}${slugifyBaseUrl(
    baseUrl,
  )}`
  if (!(baseProviderId in connectedProviders)) {
    return baseProviderId
  }

  for (let suffix = 2; ; suffix++) {
    const candidate = `${baseProviderId}-${suffix}`
    if (!(candidate in connectedProviders)) {
      return candidate
    }
  }
}

export function getCustomOpenAIProviderLabel(
  providerId: string,
  provider?: ConnectedProviderInfo,
): string {
  if (!isCustomOpenAIProviderId(providerId)) {
    return providerId
  }

  const endpoint = getEndpointLabel(provider?.baseUrl)
  return endpoint
    ? `Custom OpenAI (${endpoint})`
    : 'Custom OpenAI-compatible API'
}

export function createOpenAICompatibleModelValue(
  providerId: string,
  modelId: string,
): string {
  // The legacy single provider keeps its original `custom-openai:<model>`
  // value so already-saved settings / sessions keep resolving.
  if (providerId === CUSTOM_OPENAI_PROVIDER_ID) {
    return `${CUSTOM_OPENAI_PROVIDER_PREFIX}${modelId}`
  }
  return `${OPENAI_COMPATIBLE_MODEL_PREFIX}${encodeURIComponent(providerId)}:${modelId}`
}

export function parseOpenAICompatibleModelValue(
  value: string | undefined | null,
): OpenAICompatibleModelRef | undefined {
  if (!value) {
    return undefined
  }

  if (value.startsWith(OPENAI_COMPATIBLE_MODEL_PREFIX)) {
    const rest = value.slice(OPENAI_COMPATIBLE_MODEL_PREFIX.length)
    const separator = rest.indexOf(':')
    if (separator <= 0) {
      return undefined
    }
    const encodedProviderId = rest.slice(0, separator)
    const modelId = rest.slice(separator + 1).trim()
    if (!modelId) {
      return undefined
    }
    try {
      const providerId = decodeURIComponent(encodedProviderId)
      return providerId ? { providerId, modelId } : undefined
    } catch {
      return undefined
    }
  }

  // Legacy bare format: `custom-openai:<model>` → the bare provider id.
  if (value.startsWith(CUSTOM_OPENAI_PROVIDER_PREFIX)) {
    const modelId = value.slice(CUSTOM_OPENAI_PROVIDER_PREFIX.length).trim()
    if (!modelId) {
      return undefined
    }
    return { providerId: CUSTOM_OPENAI_PROVIDER_ID, modelId }
  }

  return undefined
}

export function getOpenAICompatibleModelId(model: string): string {
  return parseOpenAICompatibleModelValue(model)?.modelId ?? model
}

function getEndpointLabel(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined
  }

  try {
    const url = new URL(normalizeCustomOpenAIBaseUrl(baseUrl))
    const path = url.pathname === '/' ? '' : url.pathname
    return `${url.host}${path}`
  } catch {
    return normalizeCustomOpenAIBaseUrl(baseUrl)
  }
}
