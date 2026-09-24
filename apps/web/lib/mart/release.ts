/**
 * AMC Mart — goods payout release gate reader (MART_DESIGN.md §4.3).
 * Derives the gate FACTS from order_events (the append-only truth) and the
 * per-category return window, then applies the pure evaluateGoodsReleaseGate.
 * Consumers: schedulePayout (hold reasons), the admin payout release route
 * (refuses while the gate holds), and the payout-evidence dossier.
 */
import 'server-only'
import { evaluateGoodsReleaseGate, goodsReturnDeadline, type GoodsReleaseGate, type GoodsLineItem } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { getAgentSetting } from '@/lib/agent/settings'
import { getMartCategory } from './config'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export interface GoodsDossier {
  gate: GoodsReleaseGate
  returnWindowHours: number
  dispatchedAt: string | null
  deliveredPhotoAt: string | null
  buyerReceivedAt: string | null
  autoAcceptedAt: string | null
  returnOpenedAt: string | null
  returnResolvedAt: string | null
  /** order_documents ids referenced by dispatch/delivery events (evidence links). */
  evidenceDocIds: string[]
  /** Frozen totals vs listing at order time — for the "amount vs listing" dossier check. */
  lineItems: GoodsLineItem[]
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The Mart categories of an order's lines (a quoted line carries its own; catalogue lines resolve through the product). */
async function orderCategorySlugs(admin: Admin, order: any): Promise<string[]> {
  const lines = (order.line_items ?? []) as GoodsLineItem[]
  const slugs = new Set<string>(lines.map((l) => l.category_slug).filter((x): x is string => !!x))
  const productIds = lines.filter((l) => !l.category_slug && l.product_id).map((l) => l.product_id as string)
  if (productIds.length > 0) {
    const { data: prods } = await admin.from('products').select('id, category_slug').in('id', productIds)
    for (const p of prods ?? []) slugs.add((p as any).category_slug as string)
  }
  return [...slugs]
}

/** Longest return window across the order's line-item categories. */
export async function returnWindowHoursForOrder(admin: Admin, order: any): Promise<number> {
  const lines = (order.line_items ?? []) as GoodsLineItem[]
  if (lines.length === 0) return 0
  let hours = 0
  for (const slug of await orderCategorySlugs(admin, order)) {
    const cat = await getMartCategory(admin, slug)
    hours = Math.max(hours, cat?.return_window_hours ?? 0)
  }
  return hours
}

/**
 * E16 N43 — an order is returnable when any of its categories is. A wholly
 * non-returnable order still takes damaged / wrong / short claims (shared
 * returnAllowed). Never read by the release gate (money timing is unchanged).
 */
export async function orderReturnable(admin: Admin, order: any): Promise<boolean> {
  const slugs = await orderCategorySlugs(admin, order)
  if (slugs.length === 0) return true
  for (const slug of slugs) {
    const cat = await getMartCategory(admin, slug)
    if (!cat || cat.returnable !== false) return true
  }
  return false
}

/** Build the goods dossier for one order from its events. */
export async function getGoodsDossier(admin: Admin, order: any, now = new Date()): Promise<GoodsDossier> {
  const { data: events } = await admin
    .from('order_events')
    .select('event, payload, created_at')
    .eq('order_id', order.id)
    .order('created_at', { ascending: true })
  const first = (name: string) => (events ?? []).find((e: any) => e.event === name) ?? null
  const last = (name: string) => [...(events ?? [])].reverse().find((e: any) => e.event === name) ?? null

  const dispatched = first('dispatched')
  const deliveredPhoto = first('delivered_photo')
  const buyerReceived = first('buyer_received')
  const autoAccepted = first('auto_accepted')
  const returnOpened = last('return_opened')
  const returnResolved = last('return_resolved')

  const returnWindowHours = await returnWindowHoursForOrder(admin, order)
  const at = (e: any) => (e ? new Date(e.created_at) : null)
  const gate = evaluateGoodsReleaseGate({
    deliveredPhotoAt: at(deliveredPhoto),
    // A cron auto-accept (72h) counts as receipt exactly like the buyer's tap.
    buyerReceivedAt: at(buyerReceived) ?? at(autoAccepted),
    returnOpenedAt: at(returnOpened),
    returnResolvedAt: at(returnResolved),
    returnWindowHours,
    now,
  })
  const evidenceDocIds = [dispatched, deliveredPhoto]
    .flatMap((e: any) => {
      const p = e?.payload ?? {}
      return [p.dispatch_photo_doc_id, p.seller_invoice_doc_id, p.delivery_photo_doc_id]
    })
    .filter((x): x is string => typeof x === 'string')
  return {
    gate,
    returnWindowHours,
    dispatchedAt: dispatched?.created_at ?? null,
    deliveredPhotoAt: deliveredPhoto?.created_at ?? null,
    buyerReceivedAt: buyerReceived?.created_at ?? null,
    autoAcceptedAt: autoAccepted?.created_at ?? null,
    returnOpenedAt: returnOpened?.created_at ?? null,
    returnResolvedAt: returnResolved?.created_at ?? null,
    evidenceDocIds,
    lineItems: (order.line_items ?? []) as GoodsLineItem[],
  }
}

/**
 * Audit M14 — the facts shared canOpenGoodsReturn / goodsReturnDeadline need: the
 * category return window's end (from the dossier) and the post-completion dispute
 * window (agent_settings.dispute_window_days from completed_at). Server only; clients
 * receive the resulting deadline, never these inputs.
 */
export async function goodsReturnFacts(
  admin: Admin,
  order: any,
  dossier?: GoodsDossier,
): Promise<{ returnWindowEndsAt: Date | null; completedAt: string | null; disputeWindowDays: number }> {
  const [d, days] = await Promise.all([dossier ? Promise.resolve(dossier) : getGoodsDossier(admin, order), getAgentSetting(admin, 'dispute_window_days')])
  return { returnWindowEndsAt: d.gate.returnWindowEndsAt, completedAt: typeof order.completed_at === 'string' ? order.completed_at : null, disputeWindowDays: Number(days) }
}

/** Audit M14 — a completed goods order's last moment to open a return (ISO), else null (GET /orders/[id]). */
export async function goodsReturnDeadlineFor(admin: Admin, order: any): Promise<string | null> {
  if (order?.kind !== 'goods' || order.status !== 'completed') return null
  return goodsReturnDeadline({ status: 'completed', ...(await goodsReturnFacts(admin, order)) })
}
/* eslint-enable @typescript-eslint/no-explicit-any */
