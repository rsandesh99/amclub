import 'server-only'
import {
  buildFunnel,
  lossInsight,
  QUOTE_STATUS,
  quoteChargeAmounts,
  rangeDays,
  weeklyBuckets,
  type FunnelRange,
  type LossInsight,
  type WeekCounts,
} from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { getProviderFunnel } from './index'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export interface ListingPerf { packageId: string; title: string; views: number; checkouts: number; orders: number }
export interface PartnerInsights {
  range: FunnelRange
  weeks: WeekCounts[]
  loss: LossInsight
  declineReasons: { reason: string; n: number }[]
  listings: ListingPerf[]
}

const WEEKS = 8

/**
 * E11 FR-11.5 (N29 / N22) — one provider's insights, keyed to their own id.
 * The loss analysis reads the WINNING quote on each RFQ this provider lost
 * (server-side only) and returns deltas: counts always, medians only with
 * n ≥ 5, never another provider's name or price. Decline reasons n ≥ 3.
 * Never the composite AMC Score.
 */
export async function getPartnerInsights(admin: Admin, providerId: string, range: FunnelRange): Promise<PartnerInsights> {
  const now = new Date()
  const weeksSince = new Date(now.getTime() - WEEKS * 7 * 86_400_000).toISOString()
  const since = new Date(now.getTime() - rangeDays(range) * 86_400_000).toISOString()
  const [views, matched, quoted, won, funnel, mine, pkgs] = await Promise.all([
    admin.from('view_counts_daily').select('day, views').eq('provider_id', providerId).gte('day', weeksSince.slice(0, 10)),
    admin.from('rfq_matches').select('notified_at').eq('provider_id', providerId).gte('notified_at', weeksSince).limit(5000),
    admin.from('quotes').select('created_at').eq('provider_id', providerId).gte('created_at', weeksSince).limit(5000),
    admin.from('quotes').select('updated_at').eq('provider_id', providerId).eq('status', QUOTE_STATUS.accepted).gte('updated_at', weeksSince).limit(5000),
    getProviderFunnel(admin, providerId, range),
    // My quotes in the range that did not win (declined by the buyer, or passed over for another).
    admin.from('quotes').select('rfq_id, price_paise, gst_included, delivery_days, status').eq('provider_id', providerId).neq('status', QUOTE_STATUS.accepted).gte('created_at', since).limit(1000),
    admin.from('packages').select('id, title_i18n').eq('provider_id', providerId).is('deleted_at', null).limit(100),
  ])
  const weeks = weeklyBuckets(now.toISOString(), WEEKS, {
    views: (views.data ?? []).map((v) => ({ day: v.day as string, n: Number(v.views) })),
    matched: (matched.data ?? []).map((m) => m.notified_at as string),
    quoted: (quoted.data ?? []).map((q) => q.created_at as string),
    won: (won.data ?? []).map((q) => q.updated_at as string),
  })

  // N22 — winners on the RFQs I lost (services quotes; totals by the one shared rule).
  const lost = (mine.data ?? []) as { rfq_id: string; price_paise: number; gst_included: boolean | null; delivery_days: number | null }[]
  let pairs: Parameters<typeof lossInsight>[0] = []
  if (lost.length) {
    const { data: winners } = await admin.from('quotes').select('rfq_id, price_paise, gst_included, delivery_days').in('rfq_id', lost.map((q) => q.rfq_id)).eq('status', QUOTE_STATUS.accepted).neq('provider_id', providerId)
    const byRfq = new Map((winners ?? []).map((w) => [w.rfq_id as string, w]))
    const total = (p: number, g: boolean | null) => quoteChargeAmounts({ pricePaise: Number(p), gstIncluded: g, commissionBps: 0 }).totalPaise
    pairs = lost.flatMap((q) => {
      const w = byRfq.get(q.rfq_id)
      return w ? [{ mine: { totalPaise: total(q.price_paise, q.gst_included), deliveryDays: q.delivery_days }, winner: { totalPaise: total(w.price_paise as number, w.gst_included as boolean | null), deliveryDays: (w.delivery_days as number | null) ?? null } }] : []
    })
  }

  // Listing performance: views, checkouts started (the Buy-now click that reached payment), orders.
  const packages = (pkgs.data ?? []) as { id: string; title_i18n: { en?: string } | null }[]
  const ids = packages.map((p) => p.id)
  const [pv, co, ord] = ids.length
    ? await Promise.all([
        admin.from('view_counts_daily').select('subject_id, views').eq('subject_kind', 'package').in('subject_id', ids).gte('day', since.slice(0, 10)),
        admin.from('checkout_sessions').select('package_id').in('package_id', ids).gte('created_at', since).limit(5000),
        admin.from('orders').select('package_id').in('package_id', ids).gte('created_at', since).limit(5000),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }]
  const count = (rows: { package_id?: unknown }[] | null) => { const m = new Map<string, number>(); for (const r of rows ?? []) m.set(r.package_id as string, (m.get(r.package_id as string) ?? 0) + 1); return m }
  const viewsBy = new Map<string, number>()
  for (const r of (pv.data ?? []) as { subject_id: string; views: number }[]) viewsBy.set(r.subject_id, (viewsBy.get(r.subject_id) ?? 0) + Number(r.views))
  const coBy = count(co.data as { package_id?: unknown }[] | null)
  const ordBy = count(ord.data as { package_id?: unknown }[] | null)
  const listings = packages.map((p) => ({ packageId: p.id, title: p.title_i18n?.en ?? '', views: viewsBy.get(p.id) ?? 0, checkouts: coBy.get(p.id) ?? 0, orders: ordBy.get(p.id) ?? 0 }))

  return { range, weeks, loss: lossInsight(pairs), declineReasons: funnel.declineReasons, listings }
}

// Re-exported for the route (buildFunnel keeps the n ≥ 3 decline rule in one place).
export { buildFunnel }
