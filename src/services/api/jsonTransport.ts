// ---- JSON transport sanitization (shared) ----
// DeepSeek's strict JSON parser rejects lone UTF-16 surrogate escapes.
// Tool output strings may contain broken surrogates; without sanitization
// they produce different bytes under different runtime/encoding paths,
// causing false prefix-cache misses (or outright request rejection).
//
// Lives in its own module so both the main bridge (customOpenAIClient) and the
// fold summary call (deepseekFold) can share it without an import cycle.

// U+FFFD REPLACEMENT CHARACTER. Written as an escape (not the literal glyph) so
// the source stays unambiguous under any editor/encoding.
const REPLACEMENT = '\uFFFD'

export function replaceLoneSurrogates(value: string): string {
  let result = ''
  for (let i = 0; i < value.length; i++) {
    const cp = value.charCodeAt(i)
    if (cp >= 0xd800 && cp <= 0xdbff) {
      // High surrogate: check for a trailing low surrogate.
      if (i + 1 < value.length) {
        const next = value.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          result += value.charAt(i) + value.charAt(i + 1)
          i++
          continue
        }
      }
      result += REPLACEMENT
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      // Lone low surrogate.
      result += REPLACEMENT
    } else {
      result += value.charAt(i)
    }
  }
  return result
}

export function sanitizeJsonTransportValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return replaceLoneSurrogates(value)
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeJsonTransportValue)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[replaceLoneSurrogates(k)] = sanitizeJsonTransportValue(v)
    }
    return out
  }
  return value
}

export function stringifyJsonTransport(value: unknown): string {
  return JSON.stringify(sanitizeJsonTransportValue(value))
}
