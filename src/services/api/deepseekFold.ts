/**
 * DeepSeek KV-cache-aware context fold.
 *
 * When conversation history approaches the DeepSeek context window (1M tokens),
 * this module folds the oldest messages into a summary to prevent API errors and
 * keep the prefix cache stable. Mirrors Reasonix `src/context-manager.ts`.
 *
 * Key invariants:
 *  - Fold summary call is a separate lightweight call (no tools, flash model).
 *  - Stop-loss gate: fold is skipped unless head savings ≥ 30%.
 *  - Constraints are preserved: `# HIGH PRIORITY constraints` / `# User memory` /
 *    `# Project memory` blocks are extracted from the system prompt and re-appended
 *    after the summary.
 *  - **Persistence**: once a fold is computed its summary is stored and reused
 *    *verbatim* on subsequent turns as long as the original leading messages are
 *    byte-identical (append-only growth). This is the cache-stability invariant —
 *    without it, every turn would re-summarize (non-deterministically) and churn
 *    the append-only log, defeating the cache it is meant to protect. The fold is
 *    only recomputed when the kept tail itself grows back over the threshold
 *    (extending the fold) or when the main loop rewrites history (stale → discard).
 */

import { DEEPSEEK_CONTEXT_TOKENS } from '../../utils/context.js'
import { logForDebugging } from '../../utils/debug.js'
import type { OpenAIMessage } from './copilotClient.js'
import { stringifyJsonTransport } from './jsonTransport.js'

// ---- Thresholds (mirrors Reasonix context-manager.ts:24-37) ----

/** Turn-start fold at 90% — covers post-recovery, large user paste, etc.
 *  This is the active threshold used in foldDeepSeekMessagesIfNeeded(). */
const TURN_START_FOLD_THRESHOLD = 0.90
/** Stop-loss gate: skip fold if expected head savings < 30% of total. */
const HISTORY_FOLD_MIN_SAVINGS_FRACTION = 0.30
// DeepSeek context window comes from the shared source of truth in context.ts
// (DEEPSEEK_CONTEXT_TOKENS = 1M) so fold timing matches /context, the status
// row, and auto-compact — rather than folding ~8× too early at a stale 128K.
/** Model used for fold summaries — non-thinking, fast & cheap. */
const FOLD_SUMMARY_MODEL = 'deepseek-chat'
/** Fold summary timeout (ms). */
const FOLD_TIMEOUT_MS = 15_000

// ---- Persistent fold state (cache-stability invariant) ----

interface FoldState {
  /** Number of leading ORIGINAL conversation messages this fold represents. */
  sourceCount: number
  /** Fingerprint of `originalMessages.slice(0, sourceCount)` — detects whether
   *  the folded prefix is still byte-identical (append-only) vs. rewritten. */
  sourceFingerprint: string
  /** The summary message, reused verbatim each turn so its bytes never churn. */
  summaryMessage: OpenAIMessage
}

let foldState: FoldState | null = null

/** Reset persistent fold state (e.g. on `/clear` / new conversation). */
export function resetDeepSeekFoldState(): void {
  foldState = null
}

function hashString(content: string): string {
  if (
    typeof Bun !== 'undefined' &&
    typeof (Bun as { hash?: (s: string) => number }).hash === 'function'
  ) {
    return (Bun as { hash: (s: string) => number }).hash(content).toString(16)
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto') as typeof import('crypto')
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 32)
}

function fingerprintMessages(messages: OpenAIMessage[]): string {
  return hashString(JSON.stringify(messages))
}

// ---- Constraint extraction ----

/**
 * Extracts pinned constraint blocks from the system prompt so they survive
 * fold compression. Mirrors Reasonix `extractPinnedConstraints` in
 * context-manager.ts.
 */
const PINNED_BLOCK_PATTERNS = [
  /#\s+HIGH\s+PRIORITY\s+constraints[\s\S]*?(?=#\s+(?:[A-Z]|$))/g,
  /#\s+User\s+memory[\s\S]*?(?=#\s+(?:[A-Z]|$))/g,
  /#\s+Project\s+memory[\s\S]*?(?=#\s+(?:[A-Z]|$))/g,
]

function extractPinnedConstraints(systemPrompt: string): string[] {
  const blocks: string[] = []
  for (const pattern of PINNED_BLOCK_PATTERNS) {
    const matches = systemPrompt.matchAll(pattern)
    for (const m of matches) {
      blocks.push(m[0].trim())
    }
  }
  return blocks
}

// ---- Token estimation ----

const DEEPSEEK_CHARS_PER_TOKEN = 3

function estimateDeepSeekTokens(messages: OpenAIMessage[], systemPrompt: string): number {
  let chars = systemPrompt.length
  for (const msg of messages) {
    // Quick JSON serialization gives a reasonable approximation.
    // DeepSeek's BPE tokenizer averages ~3 chars/token for English.
    chars += JSON.stringify(msg).length
  }
  return Math.ceil(chars / DEEPSEEK_CHARS_PER_TOKEN)
}

// ---- Summary message construction (deterministic) ----

/**
 * Builds the fold summary message. Content is a pure function of its inputs so
 * the same fold always produces the same bytes (cache-stable).
 */
function buildSummaryMessage(
  summary: string,
  foldedCount: number,
  constraints: string[],
): OpenAIMessage {
  return {
    role: 'user',
    content:
      `[Earlier conversation summarized (${foldedCount} messages compressed)]\n\n` +
      summary +
      (constraints.length > 0
        ? '\n\n[Preserved constraints]\n' + constraints.join('\n\n')
        : ''),
  }
}

// ---- Fold summary API call ----

/**
 * Calls DeepSeek (non-thinking model) to generate a conversation summary.
 * Includes the system prompt so the summarizer understands tools and context.
 */
async function generateFoldSummary(
  messagesToFold: OpenAIMessage[],
  systemPrompt: string,
  constraints: string[],
  endpoint: string,
  apiKey: string,
): Promise<string | null> {
  const constraintsBlock = constraints.length > 0
    ? '\n\nCRITICAL: The following constraints MUST be preserved in your summary. ' +
      'Never paraphrase negation constraints (e.g., "do NOT do X"). ' +
      'Preserve the user\'s original goals.\n\n' +
      constraints.join('\n\n')
    : ''

  const summaryInstruction: OpenAIMessage = {
    role: 'user',
    content:
      'Summarize the conversation above concisely. Focus on:\n' +
      '1. What the user asked for (original goals)\n' +
      '2. What has been done so far (key actions and decisions)\n' +
      '3. What remains to be done (current state and next steps)\n' +
      '4. Any important constraints or requirements\n' +
      'Keep the summary under 500 words.' +
      constraintsBlock,
  }

  // Include system prompt as context for the summarizer.
  const messages: OpenAIMessage[] = systemPrompt
    ? [{ role: 'system' as const, content: systemPrompt }, ...messagesToFold, summaryInstruction]
    : [...messagesToFold, summaryInstruction]

  const payload = {
    model: FOLD_SUMMARY_MODEL,
    messages,
    temperature: 0,
    max_tokens: 2048,
    stream: false,
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FOLD_TIMEOUT_MS)

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: stringifyJsonTransport(payload),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      logForDebugging(
        `[DEEPSEEK-FOLD] summary call failed: HTTP ${response.status}`,
        { level: 'warn' },
      )
      return null
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>
    }
    const summary = data.choices?.[0]?.message?.content?.trim()
    if (!summary) return null

    logForDebugging(
      `[DEEPSEEK-FOLD] summary generated (${summary.length} chars)`,
      { level: 'info' },
    )
    return summary
  } catch (err) {
    logForDebugging(
      `[DEEPSEEK-FOLD] summary call error: ${(err as Error).message}`,
      { level: 'warn' },
    )
    return null
  }
}

// ---- Public API ----

export interface DeepSeekFoldResult {
  messages: OpenAIMessage[]
  folded: boolean
  foldedCount: number
  /** Messages removed from the head (replaced by summary). */
  messagesRemoved: number
}

/**
 * Resolve the chat-completions endpoint + key for the fold summary call.
 * Credentials are supplied by the caller (the bridge layer) via opts — the
 * fold module deliberately does NOT read global config / import the bridge, so
 * there is no customOpenAIClient ↔ deepseekFold import cycle.
 */
function resolveFoldCredentials(opts?: {
  endpoint?: string
  apiKey?: string
}): { endpoint: string; apiKey: string } | null {
  const baseEndpoint = opts?.endpoint ?? ''
  const apiKey = opts?.apiKey ?? ''
  if (!baseEndpoint || !apiKey) {
    logForDebugging('[DEEPSEEK-FOLD] no API credentials available', { level: 'warn' })
    return null
  }
  // Normalize endpoint to /chat/completions (no-op when already normalized).
  let endpoint = baseEndpoint.replace(/\/$/, '')
  if (!endpoint.endsWith('/chat/completions')) {
    if (endpoint.endsWith('/v1') || endpoint.endsWith('/beta')) {
      endpoint += '/chat/completions'
    } else {
      endpoint += '/v1/chat/completions'
    }
  }
  return { endpoint, apiKey }
}

/**
 * Check if context is approaching the limit and fold the oldest messages into
 * a summary if needed. Designed to be called from the bridge layer before
 * sending a DeepSeek API request.
 *
 * Persistence: the resulting summary is cached in module state and reused
 * verbatim on subsequent turns while the original leading messages are
 * unchanged, so the folded head stays byte-stable across turns.
 *
 * `messages` MUST be the conversation messages only (system prompt excluded).
 */
export async function foldDeepSeekMessagesIfNeeded(
  messages: OpenAIMessage[],
  systemPrompt: string,
  opts?: {
    /** Fold threshold override (defaults to TURN_START_FOLD_THRESHOLD). */
    threshold?: number
    /** API endpoint (defaults to provider config). */
    endpoint?: string
    /** API key (defaults to provider config). */
    apiKey?: string
  },
): Promise<DeepSeekFoldResult> {
  const threshold = opts?.threshold ?? TURN_START_FOLD_THRESHOLD
  const maxTokens = Math.floor(DEEPSEEK_CONTEXT_TOKENS * threshold)

  // 1) Reuse an existing fold if the original leading prefix is unchanged
  //    (append-only growth). This is what keeps the summary byte-stable.
  let baseMessages = messages
  let reusedFold = false
  const prevCount = foldState?.sourceCount ?? 0
  if (foldState) {
    const lead = messages.slice(0, foldState.sourceCount)
    if (
      lead.length === foldState.sourceCount &&
      fingerprintMessages(lead) === foldState.sourceFingerprint
    ) {
      baseMessages = [foldState.summaryMessage, ...messages.slice(foldState.sourceCount)]
      reusedFold = true
    } else {
      // History was rewritten/compacted by the main loop → stored fold is stale.
      logForDebugging('[DEEPSEEK-FOLD] stored fold stale (prefix changed), discarding', {
        level: 'info',
      })
      foldState = null
    }
  }

  // 2) If the (possibly already-folded) view fits, keep it as-is. Once folded,
  //    we stay folded (monotonic) so the summary bytes never disappear/reappear.
  const estimated = estimateDeepSeekTokens(baseMessages, systemPrompt)
  if (estimated < maxTokens) {
    return {
      messages: baseMessages,
      folded: reusedFold,
      foldedCount: reusedFold ? 1 : 0,
      messagesRemoved: reusedFold ? messages.length - baseMessages.length : 0,
    }
  }

  // 3) (Re)fold: pick a new boundary over baseMessages. Fold the oldest ~60%.
  const foldFraction = 0.6
  let foldPoint = Math.floor(baseMessages.length * foldFraction)

  // Safe boundary: snap to the nearest user-message boundary so we never split
  // a tool_call/tool_result pair. Walk forward first (keep more context), then
  // backwards.
  let adjusted = false
  for (let i = foldPoint; i < baseMessages.length; i++) {
    if (baseMessages[i]!.role === 'user') {
      foldPoint = i
      adjusted = true
      break
    }
  }
  if (!adjusted) {
    for (let i = foldPoint - 1; i >= 0; i--) {
      if (baseMessages[i]!.role === 'user') {
        foldPoint = i
        break
      }
    }
  }

  const toFold = baseMessages.slice(0, foldPoint)
  const toKeep = baseMessages.slice(foldPoint)

  // Truncate the kept tail to fit under the window. Used as a guaranteed-shrink
  // fallback both when the summary call fails and when a summary comes back too
  // large to actually reduce the view. Never persisted (non-deterministic), so
  // the prior foldState is left intact for the next turn.
  const truncateKeptToFit = (): DeepSeekFoldResult => {
    let kept = toKeep.length
    for (let end = toKeep.length - 1; end >= 1; end--) {
      if (estimateDeepSeekTokens(toKeep.slice(-end), systemPrompt) < maxTokens) {
        kept = end
        break
      }
    }
    // If even the last single message exceeds maxTokens (pathological), still
    // keep it — returning an empty view would be worse than a truncated one.
    if (kept === toKeep.length && toKeep.length > 1) {
      kept = 1
    }
    const truncated = toKeep.slice(-kept)
    return {
      messages: truncated,
      folded: true,
      foldedCount: 1,
      messagesRemoved: messages.length - truncated.length,
    }
  }

  if (toFold.length < 2) {
    logForDebugging(
      `[DEEPSEEK-FOLD] too few messages to fold (${toFold.length})`,
      { level: 'info' },
    )
    return {
      messages: baseMessages,
      folded: reusedFold,
      foldedCount: reusedFold ? 1 : 0,
      messagesRemoved: reusedFold ? messages.length - baseMessages.length : 0,
    }
  }

  // Stop-loss gate: if folding won't save at least 30% of tokens, skip it. The
  // cost of a prefix rewrite outweighs a marginal reduction.
  const keepTokens = estimateDeepSeekTokens(toKeep, systemPrompt)
  const savingsFraction = (estimated - keepTokens) / Math.max(estimated, 1)
  if (savingsFraction < HISTORY_FOLD_MIN_SAVINGS_FRACTION) {
    logForDebugging(
      `[DEEPSEEK-FOLD] stop-loss: savings=${(savingsFraction * 100).toFixed(1)}% < 30%`,
      { level: 'info' },
    )
    return {
      messages: baseMessages,
      folded: reusedFold,
      foldedCount: reusedFold ? 1 : 0,
      messagesRemoved: reusedFold ? messages.length - baseMessages.length : 0,
    }
  }

  const creds = resolveFoldCredentials(opts)
  if (!creds) {
    return {
      messages: baseMessages,
      folded: reusedFold,
      foldedCount: reusedFold ? 1 : 0,
      messagesRemoved: reusedFold ? messages.length - baseMessages.length : 0,
    }
  }

  const constraints = extractPinnedConstraints(systemPrompt)
  const summary = await generateFoldSummary(
    toFold,
    systemPrompt,
    constraints,
    creds.endpoint,
    creds.apiKey,
  )

  if (!summary) {
    // Summary call failed — fall back to head truncation to prevent an API
    // error. Do NOT persist this (non-deterministic / non-stable); the prior
    // foldState (if any) is kept so the next turn can retry the extend.
    logForDebugging('[DEEPSEEK-FOLD] summary failed, using truncation fallback', { level: 'warn' })
    return truncateKeptToFit()
  }

  const summaryMessage = buildSummaryMessage(summary, toFold.length, constraints)
  const result = [summaryMessage, ...toKeep]
  const resultTokens = estimateDeepSeekTokens(result, systemPrompt)

  // Post-fold safety net: a fold must actually shrink the view. The pre-fold
  // stop-loss gate can only size the folded *head* (the summary doesn't exist
  // yet); if the summary + re-pinned constraints come back no smaller than what
  // they replaced (pathological summary output or very large constraints), don't
  // persist a useless/harmful fold — truncate to fit instead.
  if (resultTokens >= estimated) {
    logForDebugging(
      `[DEEPSEEK-FOLD] summary did not shrink view (${estimated} → ${resultTokens} tokens); truncating instead`,
      { level: 'warn' },
    )
    return truncateKeptToFit()
  }

  // Persist: map the new boundary (an index into baseMessages) back to a count
  // of ORIGINAL messages. baseMessages[0] is the prior summary when reusedFold,
  // so it represents `prevCount` original messages that are not in `messages`'
  // tail; the remaining `foldPoint - (reusedFold ? 1 : 0)` folded entries are
  // original messages beyond prevCount.
  const newSourceCount = prevCount + (foldPoint - (reusedFold ? 1 : 0))
  foldState = {
    sourceCount: newSourceCount,
    sourceFingerprint: fingerprintMessages(messages.slice(0, newSourceCount)),
    summaryMessage,
  }

  logForDebugging(
    `[DEEPSEEK-FOLD] folded ${toFold.length} messages → summary (${summary.length} chars), ` +
      `sourceCount=${newSourceCount}, estimated ${estimated} → ~${resultTokens} tokens`,
    { level: 'info' },
  )

  return {
    messages: result,
    folded: true,
    foldedCount: 1,
    messagesRemoved: messages.length - result.length,
  }
}
