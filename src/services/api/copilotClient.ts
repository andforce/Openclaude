import { hasConnectedProviderCredentials } from '../../utils/connectedProviders.js'
import { getGlobalConfig, saveGlobalConfig, type ConnectedProviderInfo } from '../../utils/config.js'

const COPILOT_API_BASE = 'https://api.githubcopilot.com'
const MODELS_DEV_URL = 'https://models.dev/api.json'

export type CopilotModelInfo = {
  id: string
  label: string
  description: string
  supportedEndpoints?: string[]
}

type CopilotOutputTokenParam = 'max_tokens' | 'max_completion_tokens'
type CopilotCompatibilityInfo = {
  outputTokenParam?: CopilotOutputTokenParam
  modelSupported?: boolean
  chatCompletionsSupported?: boolean
  updatedAt: number
}

const COPILOT_COMPATIBILITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const COPILOT_CHAT_COMPLETIONS_ENDPOINT = '/chat/completions'

export function isCopilotModel(model: string): boolean {
  return model.startsWith('copilot:')
}

export function getCopilotModelId(model: string): string {
  return model.replace(/^copilot:/, '')
}

export function getCopilotProvider(): ConnectedProviderInfo | undefined {
  const config = getGlobalConfig()
  return config.connectedProviders?.['github-copilot']
}

export function isCopilotConnected(): boolean {
  return hasConnectedProviderCredentials('github-copilot')
}

const FALLBACK_COPILOT_MODELS: CopilotModelInfo[] = [
  { id: 'copilot:claude-sonnet-4.6', label: 'Claude Sonnet 4.6', description: 'Claude Sonnet 4.6 via Copilot' },
  { id: 'copilot:claude-sonnet-4.5', label: 'Claude Sonnet 4.5', description: 'Claude Sonnet 4.5 via Copilot' },
  { id: 'copilot:claude-sonnet-4', label: 'Claude Sonnet 4', description: 'Claude Sonnet 4 via Copilot' },
  { id: 'copilot:claude-opus-4.6', label: 'Claude Opus 4.6', description: 'Claude Opus 4.6 via Copilot' },
  { id: 'copilot:claude-opus-4.5', label: 'Claude Opus 4.5', description: 'Claude Opus 4.5 via Copilot' },
  { id: 'copilot:claude-opus-41', label: 'Claude Opus 4.1', description: 'Claude Opus 4.1 via Copilot' },
  { id: 'copilot:claude-haiku-4.5', label: 'Claude Haiku 4.5', description: 'Claude Haiku 4.5 via Copilot' },
  { id: 'copilot:gpt-5.4', label: 'GPT-5.4', description: 'OpenAI GPT-5.4 via Copilot' },
  { id: 'copilot:gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'OpenAI GPT-5.4 mini via Copilot' },
  { id: 'copilot:gpt-5.3-codex', label: 'GPT-5.3-Codex', description: 'OpenAI GPT-5.3-Codex via Copilot' },
  { id: 'copilot:gpt-5.2-codex', label: 'GPT-5.2-Codex', description: 'OpenAI GPT-5.2-Codex via Copilot' },
  { id: 'copilot:gpt-5.2', label: 'GPT-5.2', description: 'OpenAI GPT-5.2 via Copilot' },
  { id: 'copilot:gpt-5.1', label: 'GPT-5.1', description: 'OpenAI GPT-5.1 via Copilot' },
  { id: 'copilot:gpt-5.1-codex', label: 'GPT-5.1-Codex', description: 'OpenAI GPT-5.1-Codex via Copilot' },
  { id: 'copilot:gpt-5.1-codex-mini', label: 'GPT-5.1-Codex-mini', description: 'OpenAI GPT-5.1-Codex-mini via Copilot' },
  { id: 'copilot:gpt-5.1-codex-max', label: 'GPT-5.1-Codex-max', description: 'OpenAI GPT-5.1-Codex-max via Copilot' },
  { id: 'copilot:gpt-5', label: 'GPT-5', description: 'OpenAI GPT-5 via Copilot' },
  { id: 'copilot:gpt-5-mini', label: 'GPT-5-mini', description: 'OpenAI GPT-5-mini via Copilot' },
  { id: 'copilot:gpt-4.1', label: 'GPT-4.1', description: 'OpenAI GPT-4.1 via Copilot' },
  { id: 'copilot:gpt-4o', label: 'GPT-4o', description: 'OpenAI GPT-4o via Copilot' },
  { id: 'copilot:gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', description: 'Google Gemini 3.1 Pro via Copilot' },
  { id: 'copilot:gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', description: 'Google Gemini 3 Pro via Copilot' },
  { id: 'copilot:gemini-3-flash-preview', label: 'Gemini 3 Flash', description: 'Google Gemini 3 Flash via Copilot' },
  { id: 'copilot:gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Google Gemini 2.5 Pro via Copilot' },
  { id: 'copilot:grok-code-fast-1', label: 'Grok Code Fast 1', description: 'xAI Grok Code Fast 1 via Copilot' },
]

let cachedModels: CopilotModelInfo[] | null = null
let copilotModelsRefreshPromise: Promise<void> | null = null

type CopilotApiModel = {
  id: string
  name?: string
  model_picker_enabled?: boolean
  policy?: { state?: string }
  supported_endpoints?: string[]
}

function supportsCopilotChatCompletions(model: CopilotModelInfo): boolean {
  return (
    !model.supportedEndpoints ||
    model.supportedEndpoints.includes(COPILOT_CHAT_COMPLETIONS_ENDPOINT)
  )
}

export async function fetchCopilotModelsFromApi(): Promise<CopilotModelInfo[] | null> {
  const provider = getCopilotProvider()
  if (!provider?.oauthToken) return null

  const response = await fetch(`${COPILOT_API_BASE}/models`, {
    headers: {
      Authorization: `Bearer ${provider.oauthToken}`,
      'User-Agent': 'claude-code/2.1.88',
      'Openai-Intent': 'conversation-edits',
      'x-initiator': 'user',
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`Copilot models API failed (${response.status})`)
  }

  const data = await response.json() as {
    data?: CopilotApiModel[]
  }
  if (!Array.isArray(data.data) || data.data.length === 0) {
    return null
  }

  const models = data.data
    .filter(model => model.model_picker_enabled !== false)
    .filter(model => model.policy?.state !== 'disabled')
    .map(
      (model): CopilotModelInfo => ({
        id: `copilot:${model.id}`,
        label: model.name || model.id,
        description: `${model.name || model.id} via Copilot`,
        supportedEndpoints: model.supported_endpoints,
      }),
    )

  return models.length > 0 ? models : null
}

export async function fetchCopilotModelsFromModelsDev(): Promise<CopilotModelInfo[]> {
  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return FALLBACK_COPILOT_MODELS

    const data = await response.json() as Record<string, { models?: Record<string, { name?: string }> }>
    const copilotProvider = data['github-copilot']
    if (!copilotProvider?.models) return FALLBACK_COPILOT_MODELS

    const models: CopilotModelInfo[] = Object.entries(copilotProvider.models).map(
      ([modelId, info]) => ({
        id: `copilot:${modelId}`,
        label: info.name || modelId,
        description: `${info.name || modelId} via Copilot`,
      }),
    )

    return models.length > 0 ? models : FALLBACK_COPILOT_MODELS
  } catch {
    return FALLBACK_COPILOT_MODELS
  }
}

export async function fetchCopilotModels(): Promise<CopilotModelInfo[]> {
  try {
    const apiModels = await fetchCopilotModelsFromApi()
    if (apiModels && apiModels.length > 0) {
      return apiModels
    }
  } catch {}

  return fetchCopilotModelsFromModelsDev()
}

function hasCopilotEndpointMetadata(models: CopilotModelInfo[]): boolean {
  return models.some(model => Array.isArray(model.supportedEndpoints))
}

function shouldUseCachedCopilotModels(cache: {
  models: CopilotModelInfo[]
  fetchedAt: number
} | null | undefined): boolean {
  if (!cache || cache.models.length === 0) return false
  if (!hasCopilotEndpointMetadata(cache.models)) return false
  return Date.now() - cache.fetchedAt < 3600_000
}

function refreshCopilotModelsCacheInBackground(): void {
  if (copilotModelsRefreshPromise || !isCopilotConnected()) {
    return
  }
  copilotModelsRefreshPromise = (async () => {
    const models = await fetchCopilotModels()
    cachedModels = models
    saveGlobalConfig(current => ({
      ...current,
      copilotModelsCache: { models, fetchedAt: Date.now() },
    }))
  })()
    .catch(() => {})
    .finally(() => {
      copilotModelsRefreshPromise = null
    })
}

export async function getCopilotModels(): Promise<CopilotModelInfo[]> {
  if (cachedModels) return filterUnavailableCopilotModels(cachedModels)

  const config = getGlobalConfig()
  const cached = config.copilotModelsCache
  if (shouldUseCachedCopilotModels(cached)) {
    cachedModels = cached.models
    return filterUnavailableCopilotModels(cachedModels)
  }

  const models = await fetchCopilotModels()
  cachedModels = models

  saveGlobalConfig(current => ({
    ...current,
    copilotModelsCache: { models, fetchedAt: Date.now() },
  }))

  return filterUnavailableCopilotModels(models)
}

export function getCopilotModelsCached(): CopilotModelInfo[] {
  if (cachedModels) {
    if (!hasCopilotEndpointMetadata(cachedModels)) {
      refreshCopilotModelsCacheInBackground()
    }
    return filterUnavailableCopilotModels(cachedModels)
  }

  const config = getGlobalConfig()
  const cached = config.copilotModelsCache
  if (cached && cached.models.length > 0) {
    cachedModels = cached.models
    if (!shouldUseCachedCopilotModels(cached)) {
      refreshCopilotModelsCacheInBackground()
    }
    return filterUnavailableCopilotModels(cachedModels)
  }

  refreshCopilotModelsCacheInBackground()
  return filterUnavailableCopilotModels(FALLBACK_COPILOT_MODELS)
}

export { FALLBACK_COPILOT_MODELS as COPILOT_MODELS }

function getCachedCopilotCompatibility(
  modelId: string,
): CopilotCompatibilityInfo | undefined {
  const compatibility = getGlobalConfig().copilotCompatibilityCache?.[modelId]
  if (!compatibility) return undefined
  if (Date.now() - compatibility.updatedAt > COPILOT_COMPATIBILITY_CACHE_TTL_MS) {
    return undefined
  }
  return compatibility
}

function filterUnavailableCopilotModels(
  models: CopilotModelInfo[],
): CopilotModelInfo[] {
  return models.filter(model => {
    if (!supportsCopilotChatCompletions(model)) {
      return false
    }
    const compatibility = getCachedCopilotCompatibility(
      getCopilotModelId(model.id),
    )
    return (
      compatibility?.modelSupported !== false &&
      compatibility?.chatCompletionsSupported !== false
    )
  })
}

function saveCopilotCompatibility(
  modelId: string,
  updates: Partial<CopilotCompatibilityInfo>,
): void {
  saveGlobalConfig(current => {
    const existing = current.copilotCompatibilityCache?.[modelId]
    const next = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    } satisfies CopilotCompatibilityInfo

    if (
      existing?.outputTokenParam === next.outputTokenParam &&
      existing?.modelSupported === next.modelSupported &&
      existing?.chatCompletionsSupported === next.chatCompletionsSupported
    ) {
      return current
    }

    return {
      ...current,
      copilotCompatibilityCache: {
        ...current.copilotCompatibilityCache,
        [modelId]: next,
      },
    }
  })
}

function getPreferredCopilotOutputTokenParam(
  modelId: string,
): CopilotOutputTokenParam {
  return (
    getCachedCopilotCompatibility(modelId)?.outputTokenParam ??
    'max_tokens'
  )
}

function savePreferredCopilotOutputTokenParam(
  modelId: string,
  outputTokenParam: CopilotOutputTokenParam,
): void {
  saveCopilotCompatibility(modelId, { outputTokenParam })
}

function buildCopilotChatRequestBody(params: {
  modelId: string
  messages: OpenAIMessage[]
  isStreaming: boolean
  maxTokens?: number
  tools?: OpenAITool[]
  outputTokenParam: CopilotOutputTokenParam
}): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    model: params.modelId,
    messages: params.messages,
    stream: params.isStreaming,
  }

  if (params.maxTokens) {
    requestBody[params.outputTokenParam] = params.maxTokens
  }

  if (params.tools && params.tools.length > 0) {
    requestBody.tools = params.tools
    requestBody.tool_choice = 'auto'
  }

  return requestBody
}

async function createCopilotErrorInfo(response: Response): Promise<{
  message?: string
  code?: string
}> {
  const text = await response
    .clone()
    .text()
    .catch(() => '')
  if (!text) return {}
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; code?: string }
    }
    return {
      message: parsed.error?.message,
      code: parsed.error?.code,
    }
  } catch {
    return {}
  }
}

function createCachedCopilotErrorResponse(
  message: string,
  code: string,
): Response {
  return new Response(JSON.stringify({ error: { message, code } }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })
}

function getSuggestedCopilotOutputTokenParam(
  currentParam: CopilotOutputTokenParam,
  errorMessage: string | undefined,
): CopilotOutputTokenParam | undefined {
  if (!errorMessage) return undefined
  if (
    currentParam === 'max_tokens' &&
    errorMessage.includes("Use 'max_completion_tokens' instead")
  ) {
    return 'max_completion_tokens'
  }
  if (
    currentParam === 'max_completion_tokens' &&
    errorMessage.includes("Use 'max_tokens' instead")
  ) {
    return 'max_tokens'
  }
  return undefined
}

async function postCopilotChatCompletion(params: {
  oauthToken: string
  requestBody: Record<string, unknown>
  signal?: AbortSignal
}): Promise<Response> {
  return fetch(`${COPILOT_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.oauthToken}`,
      'User-Agent': 'claude-code/2.1.88',
      'Openai-Intent': 'conversation-edits',
      'x-initiator': 'user',
    },
    body: JSON.stringify(params.requestBody),
    signal: params.signal,
  })
}

function saveCopilotCompatibilityFromError(
  modelId: string,
  errorInfo: { code?: string },
): void {
  if (errorInfo.code === 'model_not_supported') {
    saveCopilotCompatibility(modelId, {
      modelSupported: false,
      chatCompletionsSupported: false,
    })
  } else if (errorInfo.code === 'unsupported_api_for_model') {
    saveCopilotCompatibility(modelId, {
      chatCompletionsSupported: false,
    })
  }
}

async function sendCopilotChatCompletion(params: {
  oauthToken: string
  modelId: string
  messages: OpenAIMessage[]
  isStreaming: boolean
  maxTokens?: number
  tools?: OpenAITool[]
  signal?: AbortSignal
}): Promise<Response> {
  const compatibility = getCachedCopilotCompatibility(params.modelId)
  if (compatibility?.modelSupported === false) {
    return createCachedCopilotErrorResponse(
      `Copilot model "${params.modelId}" was previously rejected as unsupported.`,
      'model_not_supported',
    )
  }
  if (compatibility?.chatCompletionsSupported === false) {
    return createCachedCopilotErrorResponse(
      `Copilot model "${params.modelId}" does not support the /chat/completions endpoint.`,
      'unsupported_api_for_model',
    )
  }

  let outputTokenParam = getPreferredCopilotOutputTokenParam(params.modelId)
  let requestBody = buildCopilotChatRequestBody({
    modelId: params.modelId,
    messages: params.messages,
    isStreaming: params.isStreaming,
    maxTokens: params.maxTokens,
    tools: params.tools,
    outputTokenParam,
  })

  let response = await postCopilotChatCompletion({
    oauthToken: params.oauthToken,
    requestBody,
    signal: params.signal,
  })
  if (response.ok) {
    saveCopilotCompatibility(params.modelId, {
      modelSupported: true,
      chatCompletionsSupported: true,
      outputTokenParam,
    })
    return response
  }

  const errorInfo = await createCopilotErrorInfo(response)
  if (!params.maxTokens) {
    saveCopilotCompatibilityFromError(params.modelId, errorInfo)
    return response
  }
  const suggestedParam = getSuggestedCopilotOutputTokenParam(
    outputTokenParam,
    errorInfo.message,
  )
  if (!suggestedParam) {
    saveCopilotCompatibilityFromError(params.modelId, errorInfo)
    return response
  }

  savePreferredCopilotOutputTokenParam(params.modelId, suggestedParam)
  outputTokenParam = suggestedParam
  requestBody = buildCopilotChatRequestBody({
    modelId: params.modelId,
    messages: params.messages,
    isStreaming: params.isStreaming,
    maxTokens: params.maxTokens,
    tools: params.tools,
    outputTokenParam,
  })

  response = await postCopilotChatCompletion({
    oauthToken: params.oauthToken,
    requestBody,
    signal: params.signal,
  })
  if (response.ok) {
    saveCopilotCompatibility(params.modelId, {
      modelSupported: true,
      chatCompletionsSupported: true,
      outputTokenParam,
    })
    return response
  }

  saveCopilotCompatibilityFromError(
    params.modelId,
    await createCopilotErrorInfo(response),
  )
  return response
}

type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  // DeepSeek thinking-mode models require reasoning_content to be echoed back on
  // any assistant turn that carries tool_calls, or the next request fails with 400.
  reasoning_content?: string
}

type OpenAITool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
    strict?: boolean
  }
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: string; text?: string }> }
  | { type: 'thinking'; thinking: string }
  | Record<string, unknown>

export type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export function convertAnthropicMessagesToOpenAI(
  messages: AnthropicMessage[],
  systemPrompt?: string,
  opts?: { deepseek?: boolean },
): OpenAIMessage[] {
  const result: OpenAIMessage[] = []
  const deepseek = opts?.deepseek === true

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content })
      continue
    }

    if (msg.role === 'user') {
      const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
      const toolResults: OpenAIMessage[] = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: (block as { type: 'text'; text: string }).text })
        } else if (block.type === 'image') {
          const imgBlock = block as { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${imgBlock.source.media_type};base64,${imgBlock.source.data}` },
          })
        } else if (block.type === 'tool_result') {
          const trBlock = block as { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: string; text?: string }> }
          let content = ''
          if (typeof trBlock.content === 'string') {
            content = trBlock.content
          } else if (Array.isArray(trBlock.content)) {
            content = trBlock.content
              .filter(c => c.type === 'text')
              .map(c => c.text || '')
              .join('\n')
          }
          toolResults.push({
            role: 'tool',
            content,
            tool_call_id: trBlock.tool_use_id,
          })
        }
      }

      if (toolResults.length > 0) {
        result.push(...toolResults)
        if (parts.length > 0) {
          result.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text! : parts })
        }
      } else if (parts.length > 0) {
        result.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text! : parts })
      }
    } else if (msg.role === 'assistant') {
      const textParts: string[] = []
      const reasoningParts: string[] = []
      const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push((block as { type: 'text'; text: string }).text)
        } else if (block.type === 'thinking') {
          reasoningParts.push((block as { type: 'thinking'; thinking: string }).thinking || '')
        } else if (block.type === 'tool_use') {
          const tuBlock = block as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
          toolCalls.push({
            id: tuBlock.id,
            type: 'function',
            function: {
              name: tuBlock.name,
              arguments: JSON.stringify(tuBlock.input),
            },
          })
        }
      }

      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: textParts.join('\n') || '',
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }
      // DeepSeek thinking-mode models reject a follow-up request unless every
      // assistant turn that has tool_calls echoes back reasoning_content. The
      // field only needs to be present (empty string is accepted); preserve the
      // real reasoning when we captured it as a thinking block.
      if (deepseek && toolCalls.length > 0) {
        assistantMsg.reasoning_content = reasoningParts.join('')
      } else if (deepseek && reasoningParts.length > 0) {
        assistantMsg.reasoning_content = reasoningParts.join('')
      }
      result.push(assistantMsg)
    }
  }

  return result
}

export function convertAnthropicToolsToOpenAI(
  tools: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>,
): OpenAITool[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }))
}

export type CopilotStreamEvent =
  | { type: 'message_start'; message: { id: string; type: 'message'; role: 'assistant'; model: string; content: []; usage: { input_tokens: number; output_tokens: number } } }
  | { type: 'content_block_start'; index: number; content_block: { type: 'text'; text: string } }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string }; usage: { output_tokens: number } }
  | { type: 'message_stop' }

export async function* streamCopilotRequest(
  model: string,
  messages: AnthropicMessage[],
  systemPrompt: string | undefined,
  tools: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>,
  signal: AbortSignal,
): AsyncGenerator<CopilotStreamEvent> {
  const provider = getCopilotProvider()
  if (!provider?.oauthToken) {
    throw new Error('GitHub Copilot is not connected. Use /connect to authenticate.')
  }

  const copilotModelId = getCopilotModelId(model)
  const openaiMessages = convertAnthropicMessagesToOpenAI(messages, systemPrompt)
  const openaiTools = tools.length > 0 ? convertAnthropicToolsToOpenAI(tools) : undefined
  const response = await sendCopilotChatCompletion({
    oauthToken: provider.oauthToken,
    modelId: copilotModelId,
    messages: openaiMessages,
    isStreaming: true,
    maxTokens: 16384,
    tools: openaiTools,
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error')
    throw new Error(`Copilot API error (${response.status}): ${errorText}`)
  }

  if (!response.body) {
    throw new Error('No response body from Copilot API')
  }

  const messageId = `msg_copilot_${Date.now()}`
  let contentIndex = 0
  let hasStartedContent = false
  let currentToolCallIndex = -1
  const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map()
  let totalOutputTokens = 0

  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: copilotModelId,
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          if (hasStartedContent) {
            yield { type: 'content_block_stop', index: contentIndex - 1 }
          }
          for (const [idx, tc] of toolCalls) {
            yield {
              type: 'content_block_stop',
              index: contentIndex + idx,
            }
          }
          yield {
            type: 'message_delta',
            delta: { stop_reason: toolCalls.size > 0 ? 'tool_use' : 'end_turn' },
            usage: { output_tokens: totalOutputTokens },
          }
          yield { type: 'message_stop' }
          return
        }

        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string | null
              tool_calls?: Array<{
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
              role?: string
            }
            finish_reason?: string | null
          }>
          usage?: { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number }
        }

        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }

        if (chunk.usage?.completion_tokens) {
          totalOutputTokens = chunk.usage.completion_tokens
        }

        const choice = chunk.choices?.[0]
        if (!choice?.delta) continue

        const delta = choice.delta

        if (delta.content != null && delta.content !== '') {
          if (!hasStartedContent) {
            hasStartedContent = true
            yield {
              type: 'content_block_start',
              index: contentIndex,
              content_block: { type: 'text', text: '' },
            }
          }
          yield {
            type: 'content_block_delta',
            index: contentIndex,
            delta: { type: 'text_delta', text: delta.content },
          }
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              if (hasStartedContent && currentToolCallIndex === -1) {
                yield { type: 'content_block_stop', index: contentIndex }
                contentIndex++
                hasStartedContent = false
              }
              currentToolCallIndex = tc.index
              toolCalls.set(tc.index, {
                id: tc.id,
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || '',
              })
              const toolBlockIndex = hasStartedContent ? contentIndex + 1 + tc.index : contentIndex + tc.index
              yield {
                type: 'content_block_start' as const,
                index: toolBlockIndex,
                content_block: {
                  type: 'text',
                  text: '',
                } as any,
              }
            } else if (tc.function?.arguments) {
              const existing = toolCalls.get(tc.index)
              if (existing) {
                existing.arguments += tc.function.arguments
              }
            }
          }
        }

        if (choice.finish_reason) {
          if (hasStartedContent) {
            yield { type: 'content_block_stop', index: contentIndex }
          }
          yield {
            type: 'message_delta',
            delta: { stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn' },
            usage: { output_tokens: totalOutputTokens },
          }
          yield { type: 'message_stop' }
          return
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: totalOutputTokens },
  }
  yield { type: 'message_stop' }
}

export function createCopilotFetchOverride(
  model: string,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const provider = getCopilotProvider()
  if (!provider?.oauthToken) {
    throw new Error('GitHub Copilot is not connected')
  }

  const copilotModelId = getCopilotModelId(model)

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url

    if (!url.includes('/messages') && !url.includes('/v1/')) {
      return fetch(input, init)
    }

    // Token counting and other non-creation endpoints are not supported via Copilot
    if (url.includes('/count_tokens') || url.includes('/models')) {
      return new Response(JSON.stringify({ input_tokens: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    let anthropicBody: Record<string, unknown> = {}
    if (init?.body) {
      try {
        anthropicBody = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as ArrayBuffer))
      } catch {
        return fetch(input, init)
      }
    }

    const systemBlocks = anthropicBody.system as Array<{ type: string; text: string }> | string | undefined
    let systemPrompt = ''
    if (typeof systemBlocks === 'string') {
      systemPrompt = systemBlocks
    } else if (Array.isArray(systemBlocks)) {
      systemPrompt = systemBlocks
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n\n')
    }

    const anthropicMessages = (anthropicBody.messages || []) as AnthropicMessage[]
    const openaiMessages = convertAnthropicMessagesToOpenAI(anthropicMessages, systemPrompt)

    const anthropicTools = (anthropicBody.tools || []) as Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>
    const openaiTools = anthropicTools.length > 0 ? convertAnthropicToolsToOpenAI(anthropicTools) : undefined

    const isStreaming = anthropicBody.stream === true
    const maxTokens =
      typeof anthropicBody.max_tokens === 'number'
        ? anthropicBody.max_tokens
        : undefined

    const copilotResponse = await sendCopilotChatCompletion({
      oauthToken: provider.oauthToken,
      modelId: copilotModelId,
      messages: openaiMessages,
      isStreaming,
      maxTokens,
      tools: openaiTools,
      signal: init?.signal,
    })

    if (!copilotResponse.ok) {
      return copilotResponse
    }

    if (!isStreaming) {
      const data = await copilotResponse.json() as {
        id: string
        choices: Array<{
          message: {
            role: string
            content: string | null
            tool_calls?: Array<{
              id: string
              function: { name: string; arguments: string }
            }>
          }
          finish_reason: string
        }>
        usage?: { prompt_tokens: number; completion_tokens: number }
      }

      const choice = data.choices[0]
      const anthropicContent: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> = []

      if (choice?.message?.content) {
        anthropicContent.push({ type: 'text', text: choice.message.content })
      }

      if (choice?.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          anthropicContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || '{}'),
          })
        }
      }

      const anthropicResponse = {
        id: data.id || `msg_copilot_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: anthropicContent,
        model: copilotModelId,
        stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
        usage: {
          input_tokens: data.usage?.prompt_tokens || 0,
          output_tokens: data.usage?.completion_tokens || 0,
        },
      }

      return new Response(JSON.stringify(anthropicResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (!copilotResponse.body) {
      return copilotResponse
    }

    const transformStream = convertOpenAIStreamToAnthropic(
      copilotResponse.body,
      copilotModelId,
    )

    return new Response(transformStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }
}

export function convertOpenAIStreamToAnthropic(
  openaiStream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let buffer = ''
  let contentIndex = 0
  let hasStartedText = false
  let totalOutputTokens = 0
  const messageId = `msg_copilot_${Date.now()}`
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
  let sentMessageStart = false
  // DeepSeek thinking-mode models stream their chain-of-thought in
  // `delta.reasoning_content` (before content/tool_calls). Surface it as an
  // Anthropic `thinking` block at index 0 so it renders and round-trips.
  let reasoningStarted = false
  let reasoningStopped = false

  return new ReadableStream({
    async start(controller) {
      const reader = openaiStream.getReader()

      function emitEvent(event: Record<string, unknown>) {
        const eventType = event.type as string
        controller.enqueue(
          encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`),
        )
      }

      function closeReasoning() {
        if (reasoningStarted && !reasoningStopped) {
          reasoningStopped = true
          emitEvent({ type: 'content_block_stop', index: 0 })
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (data === '[DONE]') {
              closeReasoning()
              if (hasStartedText) {
                emitEvent({ type: 'content_block_stop', index: contentIndex })
              }
              for (const [idx, tc] of toolCalls) {
                const toolBlockIndex = (hasStartedText ? 1 : 0) + idx
                emitEvent({
                  type: 'content_block_stop',
                  index: toolBlockIndex,
                })
              }
              emitEvent({
                type: 'message_delta',
                delta: { stop_reason: toolCalls.size > 0 ? 'tool_use' : 'end_turn' },
                usage: { output_tokens: totalOutputTokens },
              })
              emitEvent({ type: 'message_stop' })
              controller.close()
              return
            }

            let chunk: Record<string, unknown>
            try {
              chunk = JSON.parse(data)
            } catch {
              continue
            }

            if (!sentMessageStart) {
              sentMessageStart = true
              emitEvent({
                type: 'message_start',
                message: {
                  id: messageId,
                  type: 'message',
                  role: 'assistant',
                  model,
                  content: [],
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              })
            }

            const usage = chunk.usage as { completion_tokens?: number } | undefined
            if (usage?.completion_tokens) {
              totalOutputTokens = usage.completion_tokens
            }

            const choices = chunk.choices as Array<{
              delta?: {
                content?: string | null
                reasoning_content?: string | null
                tool_calls?: Array<{
                  index: number
                  id?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
              finish_reason?: string | null
            }> | undefined

            const choice = choices?.[0]
            if (!choice?.delta) continue

            const delta = choice.delta

            const reasoning = delta.reasoning_content
            if (reasoning != null && reasoning !== '' && !reasoningStopped) {
              if (!reasoningStarted) {
                reasoningStarted = true
                emitEvent({
                  type: 'content_block_start',
                  index: 0,
                  content_block: { type: 'thinking', thinking: '' },
                })
                // Reasoning occupies index 0; text/tool blocks come after it.
                if (!hasStartedText && toolCalls.size === 0) {
                  contentIndex = 1
                }
              }
              emitEvent({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: reasoning },
              })
            }

            if (delta.content != null && delta.content !== '') {
              closeReasoning()
              if (!hasStartedText) {
                hasStartedText = true
                emitEvent({
                  type: 'content_block_start',
                  index: contentIndex,
                  content_block: { type: 'text', text: '' },
                })
              }
              emitEvent({
                type: 'content_block_delta',
                index: contentIndex,
                delta: { type: 'text_delta', text: delta.content },
              })
            }

            if (delta.tool_calls) {
              closeReasoning()
              for (const tc of delta.tool_calls) {
                if (tc.id) {
                  if (hasStartedText && toolCalls.size === 0) {
                    emitEvent({ type: 'content_block_stop', index: contentIndex })
                    contentIndex++
                  }
                  const initialArgs = tc.function?.arguments || ''
                  toolCalls.set(tc.index, {
                    id: tc.id,
                    name: tc.function?.name || '',
                    arguments: initialArgs,
                  })
                  const toolBlockIndex = contentIndex + tc.index
                  emitEvent({
                    type: 'content_block_start',
                    index: toolBlockIndex,
                    content_block: {
                      type: 'tool_use',
                      id: tc.id,
                      name: tc.function?.name || '',
                      input: {},
                    },
                  })
                  // DeepSeek (and some OpenAI-compatible servers) pack the first
                  // argument fragment into the same chunk that carries the id.
                  // Emit it as a delta so it is not lost during reconstruction.
                  if (initialArgs) {
                    emitEvent({
                      type: 'content_block_delta',
                      index: toolBlockIndex,
                      delta: {
                        type: 'input_json_delta',
                        partial_json: initialArgs,
                      },
                    })
                  }
                } else if (tc.function?.arguments) {
                  const existing = toolCalls.get(tc.index)
                  if (existing) {
                    existing.arguments += tc.function.arguments
                    const toolBlockIndex = contentIndex + tc.index
                    emitEvent({
                      type: 'content_block_delta',
                      index: toolBlockIndex,
                      delta: {
                        type: 'input_json_delta',
                        partial_json: tc.function.arguments,
                      },
                    })
                  }
                }
              }
            }

            if (choice.finish_reason) {
              closeReasoning()
              if (hasStartedText && toolCalls.size === 0) {
                emitEvent({ type: 'content_block_stop', index: contentIndex })
              }
              for (const [idx, tc] of toolCalls) {
                const toolBlockIndex = contentIndex + idx
                emitEvent({ type: 'content_block_stop', index: toolBlockIndex })
              }
              emitEvent({
                type: 'message_delta',
                delta: {
                  stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
                },
                usage: { output_tokens: totalOutputTokens },
              })
              emitEvent({ type: 'message_stop' })
              controller.close()
              return
            }
          }
        }

        if (!sentMessageStart) {
          emitEvent({
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })
        }
        emitEvent({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: totalOutputTokens },
        })
        emitEvent({ type: 'message_stop' })
        controller.close()
      } catch (err) {
        controller.error(err)
      } finally {
        reader.releaseLock()
      }
    },
  })
}
