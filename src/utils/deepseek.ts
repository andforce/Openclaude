import type { GlobalConfig } from './config.js'
import { parseOpenAICompatibleModelValue } from './customOpenAIProviders.js'

const DEEPSEEK_OFFICIAL_HOST = 'api.deepseek.com'

/** True only for a provider URL hosted by the official DeepSeek API. */
export function isDeepSeekOfficialBaseUrl(
  baseUrl: string | undefined,
): boolean {
  if (!baseUrl) {
    return false
  }
  try {
    return new URL(baseUrl).hostname.toLowerCase() === DEEPSEEK_OFFICIAL_HOST
  } catch {
    return false
  }
}

/**
 * Whether a model value resolves to the official DeepSeek provider selected by
 * /connect (or another login flow that writes the same connected provider).
 * Model-name-only matches are intentionally excluded so DeepSeek-specific
 * request parameters do not leak to proxies or unrelated providers.
 */
export function isDeepSeekOfficialModelSelection(
  model: string,
  config: GlobalConfig,
): boolean {
  const ref = parseOpenAICompatibleModelValue(model)
  if (!ref) {
    return false
  }
  return isDeepSeekOfficialBaseUrl(
    config.connectedProviders?.[ref.providerId]?.baseUrl,
  )
}
