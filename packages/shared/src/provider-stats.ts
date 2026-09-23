import { ORDER_DONE_STATUSES, ORDER_IN_FLIGHT_STATUSES, type OrderStatus } from './state-machines'

/**
 * E0 / U8 — the provider home's three numbers, computed ONCE on the server
 * (web page + `GET /api/v1/partner/stats` for mobile). Money stays in paise and
 * is never summed on a client.
 */
export interface ProviderOrderStats {
  activeCount: number
  completedCount: number
  /** Σ provider_earning_paise over completed (incl. reviewed) orders. */
  earningsPaise: number
}

export function summarizeProviderOrders(rows: { status: string; provider_earning_paise: number | string | null }[]): ProviderOrderStats {
  let activeCount = 0
  let completedCount = 0
  let earningsPaise = 0
  for (const r of rows) {
    const s = r.status as OrderStatus
    if (ORDER_IN_FLIGHT_STATUSES.includes(s)) activeCount++
    else if (ORDER_DONE_STATUSES.includes(s)) {
      completedCount++
      earningsPaise += Number(r.provider_earning_paise ?? 0)
    }
  }
  return { activeCount, completedCount, earningsPaise }
}
