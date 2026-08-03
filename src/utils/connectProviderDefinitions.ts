export const OPENROUTER_ANTHROPIC_BASE_URL = 'https://openrouter.ai/api'

type BaseConnectProviderDefinition = {
  id: string
  label: string
  hint: string
}

type CustomConnectProviderDefinition = BaseConnectProviderDefinition & {
  kind: 'custom-anthropic' | 'custom-openai'
}

type OpenAICompatiblePresetProviderShape =
  BaseConnectProviderDefinition & {
    kind: 'preset-openai'
    baseUrl: string
    apiKeyUrl: string
    keyPlaceholder: string
    defaultModel?: string
  }

type OpenRouterProviderDefinition = BaseConnectProviderDefinition & {
  kind: 'openrouter'
  baseUrl: string
  apiKeyUrl: string
  keyPlaceholder: string
}

export type ConnectProviderDefinition =
  | CustomConnectProviderDefinition
  | OpenAICompatiblePresetProviderShape
  | OpenRouterProviderDefinition

export const CONNECT_PROVIDER_DEFINITIONS = [
  {
    id: 'custom-anthropic',
    kind: 'custom-anthropic',
    label: 'Custom Anthropic-compatible API',
    hint: 'Self-hosted or LAN · base URL + optional key · pick model from /v1/models',
  },
  {
    id: 'custom-openai',
    kind: 'custom-openai',
    label: 'Custom OpenAI-compatible API',
    hint: 'OpenAI /v1/chat/completions · OpenAI, Ollama, vLLM, LM Studio… · base URL + optional key',
  },
  {
    id: 'mimo-token-plan',
    kind: 'preset-openai',
    label: 'Xiaomi MiMo Token Plan',
    hint: 'MiMo Token Plan (CN) · enter your API token · auto-fetches models',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com',
    apiKeyUrl: 'https://platform.xiaomimimo.com/',
    keyPlaceholder: 'sk-...',
    defaultModel: undefined,
  },
  {
    id: 'deepseek',
    kind: 'preset-openai',
    label: 'DeepSeek',
    hint: 'DeepSeek API · enter your API token · auto-fetches models',
    baseUrl: 'https://api.deepseek.com',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    keyPlaceholder: 'sk-...',
    defaultModel: undefined,
  },
  {
    id: 'kimi-code',
    kind: 'preset-openai',
    label: 'Kimi Code',
    hint: 'Kimi Code API · enter your API token · uses kimi-for-coding',
    baseUrl: 'https://api.kimi.com/coding/v1',
    apiKeyUrl: 'https://platform.moonshot.cn/',
    keyPlaceholder: 'sk-...',
    defaultModel: 'kimi-for-coding',
  },
  {
    id: 'openrouter',
    kind: 'openrouter',
    label: 'OpenRouter Anthropic-compatible API',
    hint: 'Unified API for multiple models',
    baseUrl: OPENROUTER_ANTHROPIC_BASE_URL,
    apiKeyUrl: 'https://openrouter.ai/keys',
    keyPlaceholder: 'sk-or-...',
  },
] as const satisfies ReadonlyArray<ConnectProviderDefinition>

export type ConnectProviderId =
  (typeof CONNECT_PROVIDER_DEFINITIONS)[number]['id']

export type OpenAICompatiblePresetProviderDefinition = Extract<
  (typeof CONNECT_PROVIDER_DEFINITIONS)[number],
  { kind: 'preset-openai' }
>

export function getConnectProviderDefinition(
  providerId: string,
): (typeof CONNECT_PROVIDER_DEFINITIONS)[number] | undefined {
  return CONNECT_PROVIDER_DEFINITIONS.find(provider => provider.id === providerId)
}

export function getOpenAICompatiblePresetByBaseUrl(
  baseUrl: string | undefined,
): OpenAICompatiblePresetProviderDefinition | undefined {
  if (!baseUrl) {
    return undefined
  }

  return CONNECT_PROVIDER_DEFINITIONS.find(
    (provider): provider is OpenAICompatiblePresetProviderDefinition =>
      provider.kind === 'preset-openai' && provider.baseUrl === baseUrl,
  )
}
