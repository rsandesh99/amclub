import 'server-only'
import {
  groupPastGoodsLines,
  isPriceChanged,
  nextReorderReminderAt,
  ORDER_REPEATABLE_STATUSES,
  resolveTier,
  usualReorderIntervalDays,
} from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { createNotification } from '@/lib/notifications/create'
import { notifyText } from '@/lib/i18n/notify'
import { getPublicProductsByIds, tierDisplay, type TierDisplay } from './queries'
import { publicAssetUrl } from './assets'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * E16 N44 — the buyer's reorder library: every listing they have bought
 * (completed goods orders), the price they paid beside today's server price
 * for the same quantity (as N26 does for services), and an opt-in reminder at
 * their usual interval. Money is displayed from server paise only.
 */
export interface ReorderItem {
  productId: string
  name: string
  unit: string
  lastQty: number
  lastOrderedAt: string
  orders: number
  intervalDays: number
  /** What they paid per unit last time (the frozen snapshot). */
  then: TierDisplay
  /** Today's price for the same quantity; null when the listing is no longer available. */
  today: TierDisplay | null
  priceChanged: boolean
  /** Cart line fields for "Reorder" (null when unavailable). */
  cart: { sellerId: string; sellerName: string; minOrderQty: number; imageUrl: string | null; qty: number } | null
  reminder: { active: boolean; nextAt: string; intervalDays: number } | null
}

const LIBRARY_ORDERS = 200

export async function reorderLibrary(admin: Admin, msmeId: string, userId: string): Promise<ReorderItem[]> {
  const { data: orders } = await admin
    .from('orders')
    .select('created_at, line_items')
    .eq('msme_id', msmeId)
    .eq('kind', 'goods')
    .in('status', [...ORDER_REPEATABLE_STATUSES])
    .order('created_at', { ascending: false })
    .limit(LIBRARY_ORDERS)
  const past = groupPastGoodsLines((orders ?? []) as { created_at: string; line_items: unknown }[])
  if (!past.length) return []
  const ids = past.map((p) => p.productId)
  const [products, { data: reminders }] = await Promise.all([
    getPublicProductsByIds(ids),
    admin.from('mart_reorder_reminders').select('product_id, active, next_at, interval_days').eq('user_id', userId).in('product_id', ids),
  ])
  const byId = new Map(products.map((p) => [p.id, p]))
  const remBy = new Map(((reminders ?? []) as { product_id: string; active: boolean; next_at: string; interval_days: number }[]).map((r) => [r.product_id, r]))
  return past.map((l) => {
    const p = byId.get(l.productId)
    const qty = p ? Math.max(l.lastQty, p.minOrderQty) : l.lastQty
    const tier = p ? resolveTier(p.tiers, qty) : null
    const today = p && tier ? (p.tiers.find((t) => t.min_qty === tier.min_qty) ?? null) : null
    const then = tierDisplay({ min_qty: 1, unit_price_paise: l.lastUnitPricePaise }, l.gstRateBps, p?.itcEligible ?? true)
    const r = remBy.get(l.productId)
    return {
      productId: l.productId,
      name: p?.name ?? l.name,
      unit: l.unit,
      lastQty: l.lastQty,
      lastOrderedAt: l.lastOrderedAt,
      orders: l.orderedAt.length,
      intervalDays: usualReorderIntervalDays(l.orderedAt),
      then,
      today,
      priceChanged: today ? isPriceChanged({ taxablePaise: then.unit_price_paise }, { taxablePaise: today.unit_price_paise }) : false,
      cart: p ? { sellerId: p.seller.id, sellerName: p.seller.displayName, minOrderQty: p.minOrderQty, imageUrl: p.images[0] ? publicAssetUrl(p.images[0]) : null, qty } : null,
      reminder: r ? { active: r.active, nextAt: r.next_at, intervalDays: Number(r.interval_days) } : null,
    }
  })
}

/**
 * Turn the reminder for one listing on or off. Only for a listing the buyer
 * has bought (else null → 404); the interval is their usual one, and the
 * first reminder comes that long after their last order (tomorrow if overdue).
 */
export async function setReorderReminder(admin: Admin, msmeId: string, userId: string, productId: string, on: boolean, now = new Date()): Promise<ReorderItem['reminder'] | null> {
  const item = (await reorderLibrary(admin, msmeId, userId)).find((i) => i.productId === productId)
  if (!item) return null
  const next = nextReorderReminderAt(item.lastOrderedAt, item.intervalDays, now)
  const { data, error } = await admin
    .from('mart_reorder_reminders')
    .upsert(
      { user_id: userId, product_id: productId, interval_days: item.intervalDays, next_at: on ? next : (item.reminder?.nextAt ?? next), active: on, updated_at: now.toISOString() },
      { onConflict: 'user_id,product_id' },
    )
    .select('active, next_at, interval_days')
    .single()
  if (error || !data) throw new Error(error?.message ?? 'reminder_failed')
  return { active: data.active, nextAt: data.next_at, intervalDays: Number(data.interval_days) }
}

/**
 * Hourly (the Mart cron): send each due reminder once, then move it on by its
 * interval. The move is guarded on the next_at it read, so an overlapping run
 * cannot send the same reminder twice.
 */
export async function sendDueReorderReminders(admin: Admin, now = new Date()): Promise<{ sent: number }> {
  const { data: due } = await admin
    .from('mart_reorder_reminders')
    .select('id, user_id, product_id, interval_days, next_at, product:products(name)')
    .eq('active', true)
    .lte('next_at', now.toISOString())
    .order('next_at', { ascending: true })
    .limit(200)
  let sent = 0
  for (const r of (due ?? []) as unknown as { id: string; user_id: string; interval_days: number; next_at: string; product: { name: string } | { name: string }[] | null }[]) {
    const next = new Date(now.getTime() + Number(r.interval_days) * 86_400_000).toISOString()
    const { data: moved } = await admin.from('mart_reorder_reminders').update({ next_at: next, updated_at: now.toISOString() }).eq('id', r.id).eq('next_at', r.next_at).select('id')
    if (!moved?.length) continue
    const name = (Array.isArray(r.product) ? r.product[0]?.name : r.product?.name) ?? ''
    await createNotification(admin, {
      userId: r.user_id,
      kind: 'mart_reorder_reminder',
      titleI18n: notifyText('mart_reorder.title', { name }),
      bodyI18n: notifyText('mart_reorder.body', { days: Number(r.interval_days) }),
      link: '/app/mart/reorder',
      values: { name, days: Number(r.interval_days) },
    })
    sent++
  }
  return { sent }
}
