import * as React from 'react'
import { memo, useEffect, useState } from 'react'
import { getTotalCost } from '../cost-tracker.js'
import { useMainLoopModel } from '../hooks/useMainLoopModel.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '../ink.js'
import { getAggregateCacheHitRatio } from '../services/api/cacheDiagnostics.js'
import {
  type DeepSeekBalance,
  fetchDeepSeekBalance,
  isDeepSeekOfficialBaseUrl,
} from '../services/api/deepseekBalance.js'
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
  // messagesRef stays behind a ref (read at render); lastAssistantMessageId is
  // the actual re-render trigger (mirrors StatusLine) and the balance refresh key.
  messagesRef: React.RefObject<Message[]>
  lastAssistantMessageId: string | null
}

/** Fetch the DeepSeek balance on mount and after each turn. In-memory only. */
function useDeepSeekBalance(
  refreshKey: string | null,
  providerId: string | undefined,
): DeepSeekBalance | null {
  const [balance, setBalance] = useState<DeepSeekBalance | null>(null)
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    void (async () => {
      const b = await fetchDeepSeekBalance(controller.signal, providerId)
      if (!cancelled && b) {
        setBalance(b)
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [refreshKey, providerId])
  return balance
}

function formatTokens(n: number): string {
  return `${Math.round(n / 1000)}K`
}

function ctxColor(ratio: number): 'success' | 'warning' | 'error' {
  if (ratio >= 0.8) return 'error'
  if (ratio >= 0.5) return 'warning'
  return 'success'
}

function DeepSeekStatusRowInner({
  messagesRef,
  lastAssistantMessageId,
}: Props): React.ReactNode {
  const model = useMainLoopModel()
  const { columns } = useTerminalSize()

  // Resolve the provider for both the gate and the balance fetch so they
  // agree on which custom-openai entry to use (model's provider, not active).
  const ref = parseOpenAICompatibleModelValue(model)
  const providerId = ref?.providerId
  const provider = providerId
    ? getCustomOpenAIProvider(providerId)
    : getCustomOpenAIProvider()

  const balance = useDeepSeekBalance(lastAssistantMessageId, providerId)

  // Self-gate: render only when the current model's provider base URL is the
  // official DeepSeek endpoint. Hooks above run unconditionally (rules of hooks);
  // the balance fetch no-ops off-DeepSeek.
  if (!isDeepSeekOfficialBaseUrl(provider?.baseUrl)) {
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
          <Text color="subtle">{` · ${formatTokens(usedTokens)}/${formatTokens(cap)}`}</Text>
        )}
      </Text>

      <Text>
        <Text color="subtle">{'⛁ '}</Text>
        <Text color="text">{`¥${spent.toFixed(4)} spent`}</Text>
        {balance && (
          <>
            <Text color="subtle">{' / left '}</Text>
            <Text color="success">{`¥${balance.total.toFixed(2)}`}</Text>
          </>
        )}
      </Text>
    </Box>
  )
}

// Parent re-renders on every setMessages; memo keeps this pinned to the turn
// boundary (lastAssistantMessageId) so cost/cache/context refresh once per turn.
export const DeepSeekStatusRow = memo(DeepSeekStatusRowInner)
