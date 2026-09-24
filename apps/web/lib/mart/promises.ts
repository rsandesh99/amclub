import 'server-only'
import { activePromiseBadges, MEASURED_PROMISES, measurePromiseBreaches, ORDER_UNCHOSEN_STATUSES, type MartPromise, type PromiseBreachLimit } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { getPromiseBreachLimit } from './config'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * E16 N41 — seller promises. Breaches are measured from the order's own
 * timestamps (the dispatch photo, the invoice document named at dispatch) by
 * shared `measurePromiseBreaches`, recorded once per (order, product, promise)
 * in mart_promise_breaches (service role only), and a promise with too many
 * recent breaches loses its buyer-facing badge. Nothing here touches money or
 * the goods release gate.
 */

/** Orders older than this are settled; the hourly job never looks further back. */
const LOOKBACK_DAYS = 14
const BATCH = 500

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function measureGoodsPromiseBreaches(admin: Admin, now = new Date()): Promise<{ orders: number; breaches: number }> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString()
  const { data: orders, error } = await admin
    .from('orders')
    .select('id, created_at, status, line_items')
    .eq('kind', 'goods')
    .gte('created_at', since)
    // Cancelled / refunded orders were never the seller's to ship.
    .not('status', 'in', `(${ORDER_UNCHOSEN_STATUSES.join(',')})`)
    .order('created_at', { ascending: true })
    .limit(BATCH)
  if (error || !orders?.length) return { orders: 0, breaches: 0 }

  const productIds = [...new Set(orders.flatMap((o: any) => ((o.line_items ?? []) as { product_id?: string }[]).map((l) => l.product_id).filter(Boolean) as string[]))]
  if (!productIds.length) return { orders: 0, breaches: 0 }
  const { data: products } = await admin.from('products').select('id, seller_id, promises').in('id', productIds)
  const promised = new Map<string, { sellerId: string; promises: string[] }>()
  for (const p of (products ?? []) as any[]) {
    const measured = ((p.promises ?? []) as string[]).filter((x) => (MEASURED_PROMISES as readonly string[]).includes(x))
    if (measured.length) promised.set(p.id, { sellerId: p.seller_id, promises: measured })
  }
  const relevant = orders.filter((o: any) => ((o.line_items ?? []) as { product_id?: string }[]).some((l) => l.product_id && promised.has(l.product_id)))
  if (!relevant.length) return { orders: 0, breaches: 0 }
  const ids = relevant.map((o: any) => o.id as string)

  const [{ data: photos }, { data: events }] = await Promise.all([
    admin.from('order_documents').select('order_id, created_at').in('order_id', ids).eq('kind', 'dispatch_photo').order('created_at', { ascending: true }),
    admin.from('order_events').select('order_id, created_at, payload').in('order_id', ids).eq('event', 'dispatched').order('created_at', { ascending: true }),
  ])
  const firstPhoto = new Map<string, string>()
  for (const d of (photos ?? []) as any[]) if (!firstPhoto.has(d.order_id)) firstPhoto.set(d.order_id, d.created_at)
  const dispatched = new Map<string, { at: string; invoiceDocId: string | null }>()
  for (const e of (events ?? []) as any[]) {
    if (!dispatched.has(e.order_id)) dispatched.set(e.order_id, { at: e.created_at, invoiceDocId: (e.payload as { seller_invoice_doc_id?: string } | null)?.seller_invoice_doc_id ?? null })
  }
  const invoiceIds = [...dispatched.values()].map((d) => d.invoiceDocId).filter(Boolean) as string[]
  const invoiceAt = new Map<string, string>()
  if (invoiceIds.length) {
    const { data: docs } = await admin.from('order_documents').select('id, created_at').in('id', invoiceIds)
    for (const d of (docs ?? []) as any[]) invoiceAt.set(d.id, d.created_at)
  }

  const rows: { order_id: string; product_id: string; seller_id: string; promise: MartPromise; detail: unknown }[] = []
  for (const o of relevant as any[]) {
    const disp = dispatched.get(o.id)
    const timeline = {
      placedAt: o.created_at as string,
      dispatchPhotoAt: firstPhoto.get(o.id) ?? null,
      dispatchedAt: disp?.at ?? null,
      invoiceDocAt: disp?.invoiceDocId ? (invoiceAt.get(disp.invoiceDocId) ?? null) : null,
    }
    for (const l of (o.line_items ?? []) as { product_id?: string }[]) {
      const p = l.product_id ? promised.get(l.product_id) : undefined
      if (!p) continue
      for (const b of measurePromiseBreaches(p.promises, timeline, now)) {
        rows.push({ order_id: o.id, product_id: l.product_id!, seller_id: p.sellerId, promise: b.promise, detail: b.detail })
      }
    }
  }
  if (rows.length) {
    // One row per (order, product, promise): a re-run or a later measurement records nothing new.
    const { error: insErr } = await admin.from('mart_promise_breaches').upsert(rows, { onConflict: 'order_id,product_id,promise', ignoreDuplicates: true })
    if (insErr) console.error('[measureGoodsPromiseBreaches]', insErr.message)
  }
  return { orders: relevant.length, breaches: rows.length }
}

/** Recent breach counts per product and promise (service role; the table has no client access). */
export async function breachCounts(admin: Admin, productIds: string[], limit: PromiseBreachLimit): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>()
  if (!productIds.length) return out
  const since = new Date(Date.now() - limit.window_days * 86_400_000).toISOString()
  const { data } = await admin.from('mart_promise_breaches').select('product_id, promise').in('product_id', productIds).gte('measured_at', since)
  for (const r of (data ?? []) as { product_id: string; promise: string }[]) {
    const c = out.get(r.product_id) ?? {}
    c[r.promise] = (c[r.promise] ?? 0) + 1
    out.set(r.product_id, c)
  }
  return out
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Replace each product's opted-in promises with the badges a buyer may see.
 * Products with no promises cost nothing (no query).
 */
export async function withActiveBadges<T extends { id: string; promises: string[] }>(admin: Admin, products: T[]): Promise<T[]> {
  const promised = products.filter((p) => p.promises.length > 0)
  if (!promised.length) return products
  const limit = await getPromiseBreachLimit(admin)
  const counts = await breachCounts(admin, promised.map((p) => p.id), limit)
  return products.map((p) => (p.promises.length ? { ...p, promises: activePromiseBadges(p.promises, counts.get(p.id) ?? {}, limit) } : p))
}
