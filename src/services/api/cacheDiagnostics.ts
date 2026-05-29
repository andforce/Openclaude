/**
 * Lightweight DeepSeek KV-cache diagnostics: prefix fingerprint + miss cause
 * inference. Mirrors Reasonix `src/telemetry/cache-diagnostics.ts`.
 *
 * DeepSeek reports prompt_cache_hit/miss_tokens in the API response, but it
 * never reports WHY a miss occurred. This module computes a stable prefix
 * fingerprint (SHA-256 of system + tools) and compares it against the
 * previous turn to infer the most likely miss reason.
 */

import { logForDebugging } from '../../utils/debug.js'

// ---- Types ----

export type CacheMissReason =
  | 'no-miss'
  | 'cold-start'
  | 'system-changed'
  | 'tools-changed'
  | 'unknown'

export interface CacheDiagnosticEntry {
  turn: number
  timestamp: string
  prefixHash: string
  systemHash: string
  toolsHash: string
  promptTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  hitRate: number
  missReason: CacheMissReason
  /** DeepSeek only reports token counts — miss reasons are always inferred. */
  inferred: true
}

// ---- Internal state ----

let turnCounter = 0
let previousHashes: {
  prefixHash: string
  systemHash: string
  toolsHash: string
} | null = null

const MAX_ENTRIES = 50
const diagnosticEntries: CacheDiagnosticEntry[] = []

// ---- Hash helpers (SHA-256 via existing utility) ----

function sha16(content: string): string {
  // Use Bun.hash if available, otherwise fall back to Node crypto.
  if (
    typeof Bun !== 'undefined' &&
    typeof (Bun as { hash?: (s: string) => number }).hash === 'function'
  ) {
    // Bun.hash(wyhash) is ~100x faster than SHA-256 and collision-resistant
    // enough for diff detection. Cast to string for consistent comparison.
    return (Bun as { hash: (s: string) => number }).hash(content).toString(16).slice(0, 16)
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto') as typeof import('crypto')
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
}

// ---- Public API ----

export interface PrefixSnapshot {
  system: string
  tools: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>
}

/**
 * Record a prefix snapshot before a DeepSeek API call.
 * Call this BEFORE each turn's request.
 */
export function recordPrefixState(snapshot: PrefixSnapshot): {
  prefixHash: string
  systemHash: string
  toolsHash: string
} {
  const systemJson = JSON.stringify(snapshot.system)
  const toolsJson = JSON.stringify(
    snapshot.tools.map(t => ({ name: t.name, description: t.description, schema: t.input_schema })),
  )

  const systemHash = sha16(systemJson)
  const toolsHash = sha16(toolsJson)
  // Prefix hash over the two already-serialized components (separator can't be
  // confused with content: systemJson is JSON, so it always ends with `"`).
  const prefixHash = sha16(systemJson + ':' + toolsJson)

  return { prefixHash, systemHash, toolsHash }
}

/**
 * Record API response usage and infer cache miss reason.
 * Call this AFTER each turn's DeepSeek API response.
 */
export function recordCacheUsage(params: {
  prefixHash: string
  systemHash: string
  toolsHash: string
  promptTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
}): CacheMissReason {
  const hitRate =
    params.promptTokens > 0
      ? Math.round((params.cacheHitTokens / params.promptTokens) * 10000) / 100
      : 0

  const missReason = inferCacheMissReason(params)

  const entry: CacheDiagnosticEntry = {
    turn: turnCounter,
    timestamp: new Date().toISOString(),
    prefixHash: params.prefixHash,
    systemHash: params.systemHash,
    toolsHash: params.toolsHash,
    promptTokens: params.promptTokens,
    cacheHitTokens: params.cacheHitTokens,
    cacheMissTokens: params.cacheMissTokens,
    hitRate,
    missReason,
    inferred: true,
  }

  diagnosticEntries.push(entry)
  if (diagnosticEntries.length > MAX_ENTRIES) {
    diagnosticEntries.shift()
  }

  // Log to debug file so users running --debug-file can inspect cache behavior.
  logForDebugging(
    `[DEEPSEEK-CACHE] turn=${turnCounter} hitRate=${hitRate.toFixed(1)}% ` +
      `hit=${params.cacheHitTokens} miss=${params.cacheMissTokens} ` +
      `reason=${missReason} prefixHash=${params.prefixHash}`,
    { level: 'info' },
  )

  // Update previous state for next turn's comparison.
  previousHashes = {
    prefixHash: params.prefixHash,
    systemHash: params.systemHash,
    toolsHash: params.toolsHash,
  }
  turnCounter++

  return missReason
}

/**
 * Reset all diagnostics state (e.g., when starting a new conversation).
 */
export function resetCacheDiagnostics(): void {
  turnCounter = 0
  previousHashes = null
  diagnosticEntries.length = 0
}

/**
 * Get all recorded diagnostic entries (for export/replay).
 */
export function getCacheDiagnostics(): ReadonlyArray<CacheDiagnosticEntry> {
  return diagnosticEntries
}

/**
 * Get the aggregate cache hit ratio across all recorded turns.
 */
export function getAggregateCacheHitRatio(): number {
  if (diagnosticEntries.length === 0) return 0
  let totalPrompt = 0
  let totalHit = 0
  for (const entry of diagnosticEntries) {
    totalPrompt += entry.promptTokens
    totalHit += entry.cacheHitTokens
  }
  return totalPrompt > 0 ? Math.round((totalHit / totalPrompt) * 10000) / 100 : 0
}

// ---- Miss reason inference ----

function inferCacheMissReason(params: {
  prefixHash: string
  systemHash: string
  toolsHash: string
  cacheMissTokens: number
}): CacheMissReason {
  // No miss tokens → cache was fully hit (or cold start with 0 tokens).
  if (params.cacheMissTokens <= 0) {
    return 'no-miss'
  }

  // No previous state → this is the first turn of a session.
  if (!previousHashes) {
    return 'cold-start'
  }

  // Sub-hash comparison: which component changed?
  if (params.systemHash !== previousHashes.systemHash) {
    return 'system-changed'
  }
  if (params.toolsHash !== previousHashes.toolsHash) {
    return 'tools-changed'
  }

  // system + tools both unchanged (so prefixHash is necessarily unchanged too,
  // since it derives from them) yet miss tokens remain → the miss is outside
  // the prefix: provider TTL / cache eviction, or append-only log byte changes
  // (e.g. fold/compact rewriting the tail).
  return 'unknown'
}
