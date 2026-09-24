import 'server-only'
import { PAYOUT_RELEASE_STATUSES, type OrderStatus } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { getGoodsDossier } from '@/lib/mart/release'
import { getServicesEvidence } from '@/lib/orders/evidence'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * ADR 026 — the ONE run-time payout release rule. `runPayouts` applies it to
 * every payout it claims, so the daily cron, the admin release, dispute
 * settlement and the order-page retry all inherit it. Empty = money may move.
 *
 * - The order must be in PAYOUT_RELEASE_STATUSES (completed | resolved_release
 *   | resolved_partial). `disputed` is not, so an open dispute always blocks.
 * - A plainly `completed` order must also clear its evidence gate: the goods
 *   release gate (delivery photo, receipt, return window, no open return), or
 *   the services evidence gate once its cutover is set.
 * - `resolved_*` orders skip the evidence gates: the dispute decision is the
 *   release authority there (ADR 014).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function payoutRunBlockers(admin: Admin, order: any | null): Promise<string[]> {
  if (!order) return ['order_missing']
  const status = order.status as OrderStatus
  if (!PAYOUT_RELEASE_STATUSES.includes(status)) return [`order_status:${status}`]
  if (status !== 'completed') return []
  if (order.kind === 'goods') {
    const goods = await getGoodsDossier(admin, order)
    return goods.gate.ok ? [] : goods.gate.reasons
  }
  const ev = await getServicesEvidence(admin, order)
  return ev.enforced && !ev.gate.ok ? ev.gate.reasons : []
}
/* eslint-enable @typescript-eslint/no-explicit-any */
