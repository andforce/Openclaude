/**
 * DeepSeek account balance probe for the status row.
 *
 * Strictly gated to the OFFICIAL DeepSeek base URL (`api.deepseek.com`): only
 * there does `GET /user/balance` exist, and we don't want to leak wallet probes
 * to third-party proxies or model-name-only "deepseek" providers. Mirrors
 * Reasonix `client.getBalance()`.
 */

import {
  getCustomOpenAIProvider,
  isCustomOpenAIConnected,
} from './customOpenAIClient.js'
import { isDeepSeekOfficialBaseUrl } from '../../utils/deepseek.js'

export { isDeepSeekOfficialBaseUrl } from '../../utils/deepseek.js'

export interface DeepSeekBalance {
  currency: string
  total: number
  granted?: number
  toppedUp?: number
}

interface RawBalanceInfo {
  currency?: string
  total_balance?: string
  granted_balance?: string
  topped_up_balance?: string
}

interface RawUserBalance {
  is_available?: boolean
  balance_infos?: RawBalanceInfo[]
}

/** True when the connected custom-openai provider points at official DeepSeek. */
export function isDeepSeekOfficialActive(): boolean {
  if (!isCustomOpenAIConnected()) {
    return false
  }
  return isDeepSeekOfficialBaseUrl(getCustomOpenAIProvider()?.baseUrl)
}

/** Build the balance endpoint from the host root (never under /v1 or /beta). */
function officialBalanceUrl(baseUrl: string): string | null {
  if (!isDeepSeekOfficialBaseUrl(baseUrl)) {
    return null
  }
  try {
    const u = new URL(baseUrl)
    return `${u.origin}/user/balance`
  } catch {
    return null
  }
}

/** Pick the wallet with the largest total balance (the user's primary wallet). */
function pickPrimaryBalance(infos: RawBalanceInfo[]): DeepSeekBalance | null {
  let best: DeepSeekBalance | null = null
  for (const info of infos) {
    const total = Number(info.total_balance)
    if (!Number.isFinite(total)) {
      continue
    }
    if (!best || total > best.total) {
      best = {
        currency: info.currency || 'CNY',
        total,
        granted: info.granted_balance ? Number(info.granted_balance) : undefined,
        toppedUp: info.topped_up_balance
          ? Number(info.topped_up_balance)
          : undefined,
      }
    }
  }
  return best
}

/**
 * Fetch the DeepSeek account balance. Returns null (silently) for any non-official
 * provider, missing credentials, network error, or unexpected response shape.
 */
export async function fetchDeepSeekBalance(
  signal?: AbortSignal,
  providerId?: string,
): Promise<DeepSeekBalance | null> {
  const provider = getCustomOpenAIProvider(providerId)
  if (!provider?.baseUrl || !provider.apiKey) {
    return null
  }
  const url = officialBalanceUrl(provider.baseUrl)
  if (!url) {
    return null
  }
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        Accept: 'application/json',
      },
      signal,
    })
    if (!resp.ok) {
      return null
    }
    const data = (await resp.json()) as RawUserBalance
    if (!data || !Array.isArray(data.balance_infos)) {
      return null
    }
    return pickPrimaryBalance(data.balance_infos)
  } catch {
    return null
  }
}
