import { hasConnectedProviderCredentials } from '../../utils/connectedProviders.js'
import { getGlobalConfig, type ConnectedProviderInfo } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  CUSTOM_OPENAI_PROVIDER_ID,
  getCustomOpenAIProviderById,
  isCustomOpenAIProviderId,
  parseOpenAICompatibleModelValue,
} from '../../utils/customOpenAIProviders.js'
import { BYTES_PER_TOKEN } from '../../constants/toolLimits.js'
import {
  convertAnthropicMessagesToOpenAI,
  convertAnthropicToolsToOpenAI,
  convertToolChoice,
  convertOpenAIStreamToAnthropic,
  type AnthropicMessage,
} from './copilotClient.js'
import {
  recordPrefixState,
  recordCacheUsage,
} from './cacheDiagnostics.js'
import {
  foldDeepSeekMessagesIfNeeded,
} from './deepseekFold.js'
import { stringifyJsonTransport } from './jsonTransport.js'

/** Resolve which connected custom-openai provider a model value belongs to. */
function resolveProviderIdForModel(model: string | undefined): string {
  const cfg = getGlobalConfig()
  const ref = parseOpenAICompatibleModelValue(model)
  if (ref) {
    return ref.providerId
  }
  return isCustomOpenAIProviderId(cfg.activeProvider)
    ? cfg.activeProvider
    : CUSTOM_OPENAI_PROVIDER_ID
}

/**
 * Rough input-token estimate (chars / BYTES_PER_TOKEN) for the `/count_tokens`
 * endpoint, which OpenAI-compatible servers do not expose. Covers system,
 * message text/tool blocks, and tool schemas.
 */
function estimateAnthropicInputTokens(body: Record<string, unknown>): number {
  let chars = 0
  const add = (v: unknown): void => {
    if (typeof v === 'string') {
      chars += v.length
    }
  }

  const system = body.system
  if (typeof system === 'string') {
    add(system)
  } else if (Array.isArray(system)) {
    for (const b of system) {
      add((b as { text?: string })?.text)
    }
  }

  const messages = body.messages
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const content = (msg as { content?: unknown })?.content
      if (typeof content === 'string') {
        add(content)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as {
            type?: string
            text?: string
            input?: unknown
            content?: unknown
          }
          add(b.text)
          if (b.input !== undefined) {
            chars += JSON.stringify(b.input).length
          }
          if (typeof b.content === 'string') {
            add(b.content)
          } else if (Array.isArray(b.content)) {
            for (const inner of b.content) {
              add((inner as { text?: string })?.text)
            }
          }
        }
      }
    }
  }

  const tools = body.tools
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const t = tool as { name?: string; description?: string; input_schema?: unknown }
      add(t.name)
      add(t.description)
      if (t.input_schema !== undefined) {
        chars += JSON.stringify(t.input_schema).length
      }
    }
  }

  return Math.ceil(chars / BYTES_PER_TOKEN)
}

export function isCustomOpenAIModel(model: string | undefined): boolean {
  return !!parseOpenAICompatibleModelValue(model)
}

export function getCustomOpenAIModelId(model: string): string {
  const ref = parseOpenAICompatibleModelValue(model)
  if (ref?.modelId) {
    return ref.modelId
  }
  const p = getCustomOpenAIProvider(resolveProviderIdForModel(model))
  return p?.defaultModel || 'gpt-4o-mini'
}

export function getCustomOpenAIProvider(
  providerId?: string,
): ConnectedProviderInfo | undefined {
  // No id → the active provider (scopes DeepSeek balance to what's in use,
  // rather than any connected custom-openai endpoint). Returns undefined when
  // the active provider isn't a custom-openai one.
  const cfg = getGlobalConfig()
  return getCustomOpenAIProviderById(cfg, providerId ?? cfg.activeProvider)
}

export function isCustomOpenAIConnected(): boolean {
  const c = getGlobalConfig()
  return (
    isCustomOpenAIProviderId(c.activeProvider) &&
    hasConnectedProviderCredentials(c.activeProvider, c)
  )
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '')
}

/**
 * Check if the model requires `max_completion_tokens` instead of `max_tokens`.
 * `o1`/`o3`/`o4` reasoning models and `gpt-5` variants enforce this.
 */
function requiresMaxCompletionTokens(modelId: string): boolean {
  const m = modelId.toLowerCase()
  return (
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4-mini') ||
    m.startsWith('gpt-5')
  )
}

/** Whether this provider is DeepSeek (host `*.deepseek.com` or a `deepseek*` model). */
export function isDeepSeekProvider(baseUrl: string | undefined, modelId: string): boolean {
  if (baseUrl) {
    try {
      const host = new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase()
      if (host === 'deepseek.com' || host.endsWith('.deepseek.com')) {
        return true
      }
    } catch {
      // fall through to model-name check
    }
  }
  return modelId.toLowerCase().includes('deepseek')
}

/**
 * Whether this provider is Kimi (host `*.kimi.com` or a `kimi*` model).
 * Kimi runs a thinking mode by default and requires `reasoning_content` to be
 * echoed back on assistant tool-call turns (otherwise it 400s on the round-trip).
 */
export function isKimiProvider(baseUrl: string | undefined, modelId: string): boolean {
  if (baseUrl) {
    try {
      const host = new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase()
      if (host === 'kimi.com' || host.endsWith('.kimi.com')) {
        return true
      }
    } catch {
      // fall through to model-name check
    }
  }
  return modelId.toLowerCase().includes('kimi')
}

/** Whether the configured base points at DeepSeek's `/beta` endpoint (where strict mode lives). */
function isDeepSeekBetaBase(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false
  }
  const b = normalizeBaseUrl(baseUrl)
  try {
    return new URL(b).pathname.includes('/beta')
  } catch {
    return b.includes('/beta')
  }
}

/** Add `"null"` to a property's type so it stays optional under strict mode. */
function makeNullable(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { anyOf: [schema, { type: 'null' }] }
  }
  const s = { ...(schema as Record<string, unknown>) }
  if (typeof s.type === 'string') {
    if (s.type !== 'null') {
      s.type = [s.type, 'null']
    }
    return s
  }
  if (Array.isArray(s.type)) {
    if (!s.type.includes('null')) {
      s.type = [...s.type, 'null']
    }
    return s
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(s[key])) {
      const branches = s[key] as Array<Record<string, unknown>>
      if (!branches.some(b => b?.type === 'null')) {
        s[key] = [...branches, { type: 'null' }]
      }
      return s
    }
  }
  // $ref-only / enum-only / typeless schema: wrap so we don't add sibling keys to a $ref.
  return { anyOf: [s, { type: 'null' }] }
}

/**
 * Rewrite a JSON Schema to satisfy OpenAI/DeepSeek **strict** function mode:
 *  - every object gets `additionalProperties: false`
 *  - every property is listed in `required`; properties that were optional are
 *    made nullable instead (so they remain effectively optional, not forced)
 *  - `default` is dropped (unsupported under strict mode)
 * Recurses through properties, array items, $defs/definitions and anyOf/oneOf/allOf.
 */
function makeSchemaStrict(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') {
    return schema
  }
  if (Array.isArray(schema)) {
    return schema.map(makeSchemaStrict)
  }

  const s = { ...(schema as Record<string, unknown>) }
  delete s.default

  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(s[key])) {
      s[key] = (s[key] as unknown[]).map(makeSchemaStrict)
    }
  }
  for (const key of ['$defs', 'definitions'] as const) {
    const defs = s[key]
    if (defs && typeof defs === 'object' && !Array.isArray(defs)) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(defs as Record<string, unknown>)) {
        out[k] = makeSchemaStrict(v)
      }
      s[key] = out
    }
  }

  if (s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties)) {
    const props = s.properties as Record<string, unknown>
    const originalRequired = new Set(
      Array.isArray(s.required) ? (s.required as string[]) : [],
    )
    const newProps: Record<string, unknown> = {}
    for (const [name, propSchema] of Object.entries(props)) {
      const transformed = makeSchemaStrict(propSchema)
      newProps[name] = originalRequired.has(name) ? transformed : makeNullable(transformed)
    }
    s.properties = newProps
    s.required = Object.keys(newProps)
    s.additionalProperties = false
  }

  if (s.items) {
    s.items = Array.isArray(s.items)
      ? (s.items as unknown[]).map(makeSchemaStrict)
      : makeSchemaStrict(s.items)
  }

  return s
}

// ---- Tool schema canonicalization for cache stability ----
// DeepSeek's prefix cache is keyed by the full JSON bytes of tools. If an
// MCP server returns schemas with different key ordering across restarts,
// the byte sequence changes → cache miss. Canonicalizing schema keys to a
// deterministic order (sorted) prevents this. Mirrors Reasonix
// `canonicalizeSchemaForCache` in `src/mcp/registry.ts`.

const SET_LIKE_SCHEMA_ARRAY_KEYS = new Set(['required', 'dependentRequired'])

function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v)
}

function canonicalizeSchemaForCache(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map(item => canonicalizeSchemaForCache(item))
    if (parentKey && SET_LIKE_SCHEMA_ARRAY_KEYS.has(parentKey) && mapped.every(isScalar)) {
      return [...mapped].sort((a, b) => String(a).localeCompare(String(b)))
    }
    return mapped
  }
  if (!value || typeof value !== 'object') return value
  // `dependentRequired` values are string[] — sort both the top-level keys
  // and each value array (when it contains only scalars).
  if (parentKey === 'dependentRequired') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const arr = (value as Record<string, unknown>)[key]
      out[key] =
        Array.isArray(arr) && arr.every(isScalar)
          ? [...(arr as unknown[])].sort((a, b) => String(a).localeCompare(String(b)))
          : canonicalizeSchemaForCache(arr, key)
    }
    return out
  }
  // General object: sort keys, recurse into each value.
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalizeSchemaForCache((value as Record<string, unknown>)[key], key)
  }
  return out
}

/** Supports `https://host`, `https://host/v1`, DeepSeek `.../beta`, or a full path. */
function chatCompletionsUrl(base: string, deepseek = false): string {
  const b = normalizeBaseUrl(base)
  if (b.endsWith('/chat/completions')) {
    return b
  }
  // DeepSeek's strict-mode (beta) endpoint is `<base>/beta/chat/completions`
  // — it has no `/v1` segment, unlike the default OpenAI-compatible layout.
  if (deepseek && b.endsWith('/beta')) {
    return `${b}/chat/completions`
  }
  if (b.endsWith('/v1')) {
    return `${b}/chat/completions`
  }
  return `${b}/v1/chat/completions`
}

/**
 * OpenAI-compatible `/v1/chat/completions` bridge (same protocol as GitHub Copilot path).
 */
export function createCustomOpenAIFetchOverride(
  model: string,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  // Resolve which connected endpoint this model belongs to so multiple
  // custom-openai providers (e.g. Kimi + DeepSeek) route to the right base URL.
  const provider = getCustomOpenAIProvider(resolveProviderIdForModel(model))
  if (!provider?.baseUrl) {
    throw new Error('Custom OpenAI-compatible API is not configured')
  }

  const openaiModelId = getCustomOpenAIModelId(model)
  const deepseek = isDeepSeekProvider(provider.baseUrl, openaiModelId)
  const kimi = isKimiProvider(provider.baseUrl, openaiModelId)
  // Strict tool mode is a DeepSeek beta feature — opt in by connecting to the
  // `/beta` endpoint. It tightens function schemas so argument JSON adheres exactly.
  const useStrictTools = deepseek && isDeepSeekBetaBase(provider.baseUrl)
  const endpoint = chatCompletionsUrl(provider.baseUrl, deepseek)

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url

    if (!url.includes('/messages') && !url.includes('/v1/')) {
      return fetch(input, init)
    }

    if (url.includes('/models')) {
      return new Response(JSON.stringify({ input_tokens: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    let anthropicBody: Record<string, unknown> = {}
    if (init?.body) {
      try {
        anthropicBody = JSON.parse(
          typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as ArrayBuffer),
        )
      } catch {
        return fetch(input, init)
      }
    }

    if (url.includes('/count_tokens')) {
      return new Response(
        JSON.stringify({ input_tokens: estimateAnthropicInputTokens(anthropicBody) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const systemBlocks = anthropicBody.system as
      | Array<{ type: string; text: string }>
      | string
      | undefined
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
    let openaiMessages = convertAnthropicMessagesToOpenAI(anthropicMessages, systemPrompt, { deepseek, model: openaiModelId, requiresReasoningContent: kimi })

    const anthropicTools = (anthropicBody.tools || []) as Array<{
      name: string
      description?: string
      input_schema?: Record<string, unknown>
    }>
    // DeepSeek: sort tools by name and canonicalize input schemas so the
    // tool-list byte sequence is deterministic across MCP server restarts
    // and import-order changes. Mirrors Reasonix registry.ts:195-197.
    let stableTools = anthropicTools
    if (deepseek) {
      stableTools = anthropicTools
        .map(t => ({
          ...t,
          ...(t.input_schema
            ? { input_schema: canonicalizeSchemaForCache(t.input_schema) as Record<string, unknown> }
            : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    }
    let openaiTools = stableTools.length > 0 ? convertAnthropicToolsToOpenAI(stableTools) : undefined
    if (openaiTools && useStrictTools) {
      openaiTools = openaiTools.map(t => ({
        ...t,
        function: {
          ...t.function,
          strict: true,
          parameters: makeSchemaStrict(t.function.parameters) as Record<string, unknown>,
        },
      }))
    }

    const isStreaming = anthropicBody.stream === true

    // DeepSeek context fold: when conversation approaches the 128K token
    // window, fold oldest messages into a summary to stay under the limit.
    // The fold summary call includes the same system prompt for context, but
    // is a separate lightweight call (no tools, different model) so its cost
    // is negligible. Mirrors Reasonix context-manager.ts turn-start fold.
    if (deepseek) {
      // openaiMessages[0] is the system prompt block (added by conversion).
      // Pass conversation-only messages to fold so the system prompt isn't
      // double-counted in the token estimate.
      const hasSystemMsg = openaiMessages.length > 0 && openaiMessages[0]!.role === 'system'
      const conversationMessages = hasSystemMsg ? openaiMessages.slice(1) : openaiMessages
      // Pass the resolved endpoint + key so deepseekFold needs no back-import
      // (avoids a customOpenAIClient ↔ deepseekFold cycle).
      const foldResult = await foldDeepSeekMessagesIfNeeded(conversationMessages, systemPrompt, {
        endpoint,
        apiKey: provider.apiKey,
      })
      if (foldResult.folded) {
        openaiMessages = hasSystemMsg
          ? [openaiMessages[0]!, ...foldResult.messages]
          : foldResult.messages
      }
    }

    const requestBody: Record<string, unknown> = {
      model: openaiModelId,
      messages: openaiMessages,
      stream: isStreaming,
    }

    // DeepSeek requires stream_options.include_usage to return
    // prompt_cache_hit/miss_tokens in streaming responses. Without
    // this flag, cached tokens are billed at full price.
    if (isStreaming) {
      requestBody.stream_options = { include_usage: true }
    }

    // Some OpenAI-compatible models (o1, o3, o4-mini, gpt-5) require
    // `max_completion_tokens` instead of `max_tokens`.
    if (anthropicBody.max_tokens) {
      if (requiresMaxCompletionTokens(openaiModelId)) {
        requestBody.max_completion_tokens = anthropicBody.max_tokens
      } else {
        requestBody.max_tokens = anthropicBody.max_tokens
      }
    }

    // Pass through sampling parameters when the caller set them.
    if (typeof anthropicBody.temperature === 'number') {
      requestBody.temperature = anthropicBody.temperature
    }
    if (typeof anthropicBody.top_p === 'number') {
      requestBody.top_p = anthropicBody.top_p
    }
    if (
      Array.isArray(anthropicBody.stop_sequences) &&
      anthropicBody.stop_sequences.length > 0
    ) {
      requestBody.stop = anthropicBody.stop_sequences
    }

    if (openaiTools && openaiTools.length > 0) {
      requestBody.tools = openaiTools
      requestBody.tool_choice = convertToolChoice(anthropicBody.tool_choice) ?? 'auto'
    }

    // DeepSeek cache diagnostics: capture prefix state before the API call
    // so we can infer why a cache miss occurred. Only runs when debug
    // logging is active (--debug / --debug-file).
    let prefixSnapshot: ReturnType<typeof recordPrefixState> | null = null
    if (deepseek) {
      prefixSnapshot = recordPrefixState({
        system: systemPrompt,
        tools: stableTools,
      })
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'claude-code/2.1.88',
    }
    if (provider.apiKey) {
      headers.Authorization = `Bearer ${provider.apiKey}`
    }

    const openaiResponse = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: stringifyJsonTransport(requestBody),
      signal: init?.signal,
    })

    if (!openaiResponse.ok) {
      return openaiResponse
    }

    if (!isStreaming) {
      const data = (await openaiResponse.json()) as {
        id: string
        choices: Array<{
          message: {
            role: string
            content: string | null
            reasoning_content?: string | null
            tool_calls?: Array<{
              id: string
              function: { name: string; arguments: string }
            }>
          }
          finish_reason: string
        }>
        usage?: {
          prompt_tokens: number
          completion_tokens: number
          prompt_cache_hit_tokens?: number
          prompt_cache_miss_tokens?: number
          prompt_tokens_details?: { cached_tokens?: number }
        }
      }

      const choice = data.choices[0]
      const anthropicContent: Array<{
        type: string
        text?: string
        thinking?: string
        id?: string
        name?: string
        input?: unknown
      }> = []

      // DeepSeek thinking-mode reasoning → Anthropic thinking block (rendered + round-trips).
      if (choice?.message?.reasoning_content) {
        anthropicContent.push({ type: 'thinking', thinking: choice.message.reasoning_content })
      }

      if (choice?.message?.content) {
        anthropicContent.push({ type: 'text', text: choice.message.content })
      }

      if (choice?.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          anthropicContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: (() => {
              try {
                return JSON.parse(tc.function.arguments || '{}')
              } catch (err) {
                logForDebugging(
                  `tool_call "${tc.function.name}" arguments JSON parse failed (${(err as Error).message}); falling back to {}. raw=${(tc.function.arguments || '').slice(0, 500)}`,
                  { level: 'error' },
                )
                return {}
              }
            })(),
          })
        }
      }

      // DeepSeek's disk cache is automatic and reports the hit portion (billed
      // cheaper). Map hit -> cache_read_input_tokens and the rest -> input_tokens
      // so the existing cost/usage tracking reflects the cache discount.
      const promptTokens = data.usage?.prompt_tokens || 0
      const cacheHit =
        data.usage?.prompt_cache_hit_tokens ??
        data.usage?.prompt_tokens_details?.cached_tokens ??
        0
      const inputTokens =
        data.usage?.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHit)

      // Record DeepSeek cache diagnostics for debug inspection.
      const cacheMissTokens = data.usage?.prompt_cache_miss_tokens ??
        Math.max(0, promptTokens - cacheHit)
      if (deepseek && prefixSnapshot) {
        recordCacheUsage({
          prefixHash: prefixSnapshot.prefixHash,
          systemHash: prefixSnapshot.systemHash,
          toolsHash: prefixSnapshot.toolsHash,
          promptTokens,
          cacheHitTokens: cacheHit,
          cacheMissTokens,
        })
      }

      const anthropicResponse = {
        id: data.id || `msg_custom_openai_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: anthropicContent,
        model: openaiModelId,
        stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : choice?.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
        usage: {
          input_tokens: inputTokens,
          output_tokens: data.usage?.completion_tokens || 0,
          ...(cacheHit > 0 ? { cache_read_input_tokens: cacheHit } : {}),
        },
      }

      return new Response(JSON.stringify(anthropicResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (!openaiResponse.body) {
      return openaiResponse
    }

    // DeepSeek cache diagnostics for the streaming path (the default path).
    // Usage is only available inside the stream's final chunk, so record it via
    // a callback rather than the non-streaming branch above.
    const transformStream = convertOpenAIStreamToAnthropic(
      openaiResponse.body,
      openaiModelId,
      deepseek && prefixSnapshot
        ? usage => {
            recordCacheUsage({
              prefixHash: prefixSnapshot!.prefixHash,
              systemHash: prefixSnapshot!.systemHash,
              toolsHash: prefixSnapshot!.toolsHash,
              promptTokens: usage.promptTokens,
              cacheHitTokens: usage.cacheHitTokens,
              cacheMissTokens: usage.cacheMissTokens,
            })
          }
        : undefined,
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

function modelsListUrlFromOpenAIBase(base: string): string {
  const b = normalizeBaseUrl(base)
  if (b.endsWith('/v1')) {
    return `${b}/models`
  }
  return `${b}/v1/models`
}

function parseOpenAIStyleModelList(json: unknown): string[] {
  if (!json || typeof json !== 'object') {
    return []
  }
  const o = json as Record<string, unknown>
  const data = o.data
  if (Array.isArray(data)) {
    const ids: string[] = []
    for (const item of data) {
      if (item && typeof item === 'object' && 'id' in item && typeof (item as { id: unknown }).id === 'string') {
        ids.push((item as { id: string }).id)
      }
    }
    return [...new Set(ids.filter(Boolean))]
  }
  const models = o.models
  if (Array.isArray(models)) {
    const ids: string[] = []
    for (const item of models) {
      if (typeof item === 'string') {
        ids.push(item)
      } else if (item && typeof item === 'object' && 'id' in item && typeof (item as { id: unknown }).id === 'string') {
        ids.push((item as { id: string }).id)
      }
    }
    return [...new Set(ids.filter(Boolean))]
  }
  return []
}

/**
 * GET /v1/models (OpenAI-compatible).
 */
export async function fetchOpenAICompatibleModelIds(
  baseUrl: string,
  apiKey?: string,
): Promise<string[]> {
  const url = modelsListUrlFromOpenAIBase(baseUrl)
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenAI-compatible /v1/models failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`)
  }
  const json: unknown = await res.json()
  const ids = parseOpenAIStyleModelList(json)
  return ids
}

/**
 * GET /v1/models (Anthropic API).
 */
export async function fetchAnthropicCompatibleModelIds(
  baseUrl: string,
  apiKey?: string,
): Promise<string[]> {
  let root = baseUrl.replace(/\/$/, '')
  if (root.endsWith('/v1')) {
    root = root.slice(0, -3)
  }
  const url = `${root}/v1/models`
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  }
  if (apiKey) {
    headers['x-api-key'] = apiKey
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic /v1/models failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`)
  }
  const json: unknown = await res.json()
  const ids = parseOpenAIStyleModelList(json)
  return ids
}

/**
 * GET /v1/models from OpenRouter's Anthropic-compatible API.
 */
export async function fetchOpenRouterAnthropicModelIds(
  apiKey: string,
): Promise<string[]> {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenRouter /v1/models failed (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`)
  }
  const json: unknown = await res.json()
  const ids = parseOpenAIStyleModelList(json)
  return ids
}
