import {
  getGlobalConfig,
  type ConnectedProviderInfo,
  type GlobalConfig,
} from './config.js'
import { isCustomAnthropicProviderId } from './customAnthropicProviders.js'
import { isCustomOpenAIProviderId } from './customOpenAIProviders.js'

function hasRequiredProviderFields(
  providerId: string,
  provider: ConnectedProviderInfo | undefined,
): boolean {
  if (isCustomAnthropicProviderId(providerId)) {
    return !!provider?.baseUrl
  }
  if (isCustomOpenAIProviderId(providerId)) {
    return !!provider?.baseUrl
  }

  switch (providerId) {
    case 'github-copilot':
      return !!provider?.oauthToken
    case 'openrouter':
    case 'kimi-for-coding':
      return !!provider?.apiKey
    default:
      return !!(
        provider?.apiKey ||
        provider?.oauthToken ||
        provider?.baseUrl ||
        provider?.enterpriseUrl
      )
  }
}

export function hasConnectedProviderCredentials(
  providerId: string | undefined,
  config: GlobalConfig = getGlobalConfig(),
): boolean {
  if (!providerId) {
    return false
  }

  return hasRequiredProviderFields(
    providerId,
    config.connectedProviders?.[providerId],
  )
}

export function hasConnectedActiveProvider(
  config: GlobalConfig = getGlobalConfig(),
): boolean {
  return hasConnectedProviderCredentials(config.activeProvider, config)
}
