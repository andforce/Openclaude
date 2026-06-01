/**
 * Per-turn usage & cost indicator for MiMo (Xiaomi) providers.
 *
 * Gated to official MiMo base URLs only:
 *   - `api.xiaomimimo.com`         (pay-as-you-go)
 *   - `token-plan-cn.xiaomimimo.com` (Token Plan CN)
 *   - `token-plan-sgp.xiaomimimo.com` (Token Plan SG)
 *   - `token-plan-ams.xiaomimimo.com` (Token Plan EU)
 *
 * MiMo has no public balance API, so the row shows cumulative session spend
 * but not remaining balance.
 */

import * as React from 'react'
import { memo, useMemo } from 'react'
import { getTotalCost } from '../cost-tracker.js'
import { useMainLoopModel } from '../hooks/useMainLoopModel.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '../ink.js'
import { getAggregateCacheHitRatio } from '../services/api/cacheDiagnostics.js'
import { getCustomOpenAIProvider } from '../services/api/customOpenAIClient.js'
import type { Message } from '../types/message.js'
import {
  calculateContextPercentages,
  getContextWindowForModel,
} from '../utils/context.js'
import { parseOpenAICompatibleModelValue } from '../utils/customOpenAIProviders.js'
import { calculateCostFromTokens } from '../utils/modelCost.js'
import { getCurrentUsage } from '../utils/tokens.js'

type Props = {
  messagesRef: React.RefObject<Message[]>
  lastAssistantMessageId: string | null
}

/**
 * Official MiMo hostnames that support usage reporting in API responses.
 * Any other host is ignored (the row self-gates to null).
 */
const MIMO_HOSTS = new Set([
  'api.xiaomimimo.com',
  'token-plan-cn.xiaomimimo.com',
  'token-plan-sgp.xiaomimimo.com',
  'token-plan-ams.xiaomimimo.com',
])

export function isMiMoOfficialBaseUrl(
  baseUrl: string | undefined,
): boolean {
  if (!baseUrl) return false
  try {
    return MIMO_HOSTS.has(new URL(baseUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

function formatTokens(n: number): string {
  return `${Math.round(n / 1000)}K`
}

function ctxColor(ratio: number): 'success' | 'warning' | 'error' {
  if (ratio >= 0.8) return 'error'
  if (ratio >= 0.5) return 'warning'
  return 'success'
}

function MiMoStatusRowInner({
  messagesRef,
  lastAssistantMessageId,
}: Props): React.ReactNode {
  const model = useMainLoopModel()
  const { columns } = useTerminalSize()

  // Resolve the provider for the gate — must agree on which custom-openai
  // entry to use (model's provider, not the active one).
  const ref = parseOpenAICompatibleModelValue(model)
  const providerId = ref?.providerId
  const provider = providerId
    ? getCustomOpenAIProvider(providerId)
    : getCustomOpenAIProvider()

  // Self-gate: render only when the current model's provider base URL is an
  // official MiMo endpoint. Hooks above run unconditionally (rules of hooks).
  if (!isMiMoOfficialBaseUrl(provider?.baseUrl)) {
    return null
  }

  const usage = getCurrentUsage(messagesRef.current ?? [])
  const turnCost = usage
    ? calculateCostFromTokens(model, {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens,
      })
    : 0
  const spent = getTotalCost()
  const cacheHit = getAggregateCacheHitRatio()

  const cap = getContextWindowForModel(model)
  const ctx = calculateContextPercentages(usage, cap)
  const usedTokens = usage
    ? usage.input_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens
    : 0
  const ratio = cap > 0 ? Math.min(1, usedTokens / cap) : 0
  const pct = ctx.used ?? 0
  const barColor = ctxColor(ratio)

  // Progressive disclosure on narrow terminals.
  const showTokens = columns >= 72

  return (
    <Box gap={1}>
      <Text>
        <Text color="text">{`¥${turnCost.toFixed(4)}`}</Text>
        <Text color="subtle"> turn</Text>
      </Text>

      <Text color="subtle">
        {'cache '}
        <Text color="text">{`${Math.round(cacheHit)}%`}</Text>
      </Text>

      <Text>
        <Text color="subtle">{'ctx '}</Text>
        <Text color={barColor}>{`${pct}%`}</Text>
        {showTokens && (
          <Text color="subtle">{` \u00b7 ${formatTokens(usedTokens)}/${formatTokens(cap)}`}</Text>
        )}
      </Text>

      <Text>
        <Text color="subtle">{'\u26c1 '}</Text>
        <Text color="text">{`¥${spent.toFixed(4)} spent`}</Text>
      </Text>
    </Box>
  )
}

// Parent re-renders on every setMessages; memo keeps this pinned to the turn
// boundary (lastAssistantMessageId) so cost/cache/context refresh once per turn.
export const MiMoStatusRow = memo(MiMoStatusRowInner)
