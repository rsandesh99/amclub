/**
 * AMC Mart — goods payout release gate reader (MART_DESIGN.md §4.3).
 * Derives the gate FACTS from order_events (the append-only truth) and the
 * per-category return window, then applies the pure evaluateGoodsReleaseGate.
 * Consumers: schedulePayout (hold reasons), the admin payout release route
 * (refuses while the gate holds), and the payout-evidence dossier.
 */
import 'server-only'
import { evaluateGoodsReleaseGate, type GoodsReleaseGate, type GoodsLineItem } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
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
/** Longest return window across the order's line-item categories. */
export async function returnWindowHoursForOrder(admin: Admin, order: any): Promise<number> {
  const lines = (order.line_items ?? []) as GoodsLineItem[]
  if (lines.length === 0) return 0
  const { data: prods } = await admin.from('products').select('id, category_slug').in('id', lines.map((l) => l.product_id))
  const slugs = [...new Set((prods ?? []).map((p: any) => p.category_slug as string))]
  let hours = 0
  for (const slug of slugs) {
    const cat = await getMartCategory(admin, slug)
    hours = Math.max(hours, cat?.return_window_hours ?? 0)
  }
  return hours
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
/* eslint-enable @typescript-eslint/no-explicit-any */
