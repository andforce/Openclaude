import type { ConnectedProviderInfo, GlobalConfig } from './config.js'

export const CUSTOM_ANTHROPIC_PROVIDER_ID = 'custom-anthropic'
export const CUSTOM_ANTHROPIC_PROVIDER_PREFIX = 'custom-anthropic:'
export const ANTHROPIC_COMPATIBLE_MODEL_PREFIX = 'anthropic-compatible:'

type ModelCache = Array<{ id: string }>

export type AnthropicCompatibleModelRef = {
  providerId: string
  modelId: string
}

export function isCustomAnthropicProviderId(
  providerId: string | undefined,
): providerId is string {
  return (
    providerId === CUSTOM_ANTHROPIC_PROVIDER_ID ||
    providerId?.startsWith(CUSTOM_ANTHROPIC_PROVIDER_PREFIX) === true
  )
}

export function normalizeCustomAnthropicBaseUrl(baseUrl: string): string {
  let root = baseUrl.trim().replace(/\/+$/, '')
  if (root.endsWith('/v1')) {
    root = root.slice(0, -3)
  }
  return root
}

function slugifyBaseUrl(baseUrl: string): string {
  const normalized = normalizeCustomAnthropicBaseUrl(baseUrl)

  try {
    const url = new URL(normalized)
    const host = url.host.replace(/:/g, '-')
    const path = url.pathname
      .split('/')
      .filter(Boolean)
      .join('-')
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

export function getCustomAnthropicProvider(
  config: GlobalConfig,
  providerId: string | undefined = config.activeProvider,
): ConnectedProviderInfo | undefined {
  if (!isCustomAnthropicProviderId(providerId)) {
    return undefined
  }
  return config.connectedProviders?.[providerId]
}

export function getCustomAnthropicModels(
  config: GlobalConfig,
  providerId: string | undefined = config.activeProvider,
): ModelCache | undefined {
  if (!isCustomAnthropicProviderId(providerId)) {
    return undefined
  }

  const scopedCache = config.anthropicCustomModelsCaches?.[providerId]
  if (scopedCache) {
    return scopedCache
  }

  if (providerId === CUSTOM_ANTHROPIC_PROVIDER_ID) {
    return config.anthropicCustomModelsCache
  }

  return undefined
}

export function resolveCustomAnthropicProviderId(
  config: GlobalConfig,
  baseUrl: string,
): string {
  const normalizedBaseUrl = normalizeCustomAnthropicBaseUrl(baseUrl)
  const connectedProviders = config.connectedProviders ?? {}

  for (const [providerId, provider] of Object.entries(connectedProviders)) {
    if (
      isCustomAnthropicProviderId(providerId) &&
      provider.baseUrl &&
      normalizeCustomAnthropicBaseUrl(provider.baseUrl) === normalizedBaseUrl
    ) {
      return providerId
    }
  }

  const baseProviderId = `${CUSTOM_ANTHROPIC_PROVIDER_PREFIX}${slugifyBaseUrl(
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

export function getCustomAnthropicProviderLabel(
  providerId: string,
  provider?: ConnectedProviderInfo,
): string {
  if (!isCustomAnthropicProviderId(providerId)) {
    return providerId
  }

  const endpoint = getEndpointLabel(provider?.baseUrl)
  return endpoint
    ? `Custom Anthropic (${endpoint})`
    : 'Custom Anthropic-compatible API'
}

export function createAnthropicCompatibleModelValue(
  providerId: string,
  modelId: string,
): string {
  return `${ANTHROPIC_COMPATIBLE_MODEL_PREFIX}${encodeURIComponent(providerId)}:${modelId}`
}

export function parseAnthropicCompatibleModelValue(
  value: string | undefined | null,
): AnthropicCompatibleModelRef | undefined {
  if (!value?.startsWith(ANTHROPIC_COMPATIBLE_MODEL_PREFIX)) {
    return undefined
  }

  const rest = value.slice(ANTHROPIC_COMPATIBLE_MODEL_PREFIX.length)
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

export function getAnthropicCompatibleModelId(model: string): string {
  return parseAnthropicCompatibleModelValue(model)?.modelId ?? model
}

function getEndpointLabel(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined
  }

  try {
    const url = new URL(normalizeCustomAnthropicBaseUrl(baseUrl))
    const path = url.pathname === '/' ? '' : url.pathname
    return `${url.host}${path}`
  } catch {
    return normalizeCustomAnthropicBaseUrl(baseUrl)
  }
}
