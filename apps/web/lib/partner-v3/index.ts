import 'server-only'
import {
  applyInboxQuery,
  buildFunnel,
  isBuyerVerified,
  PAYOUT_STATUS,
  QUOTE_STATUS,
  rangeDays,
  type Funnel,
  type FunnelRange,
  type InboxFacts,
  type InboxQuery,
} from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { getAgentSetting } from '@/lib/agent/settings'
import { loadProviderInboxMatches, PROVIDER_INBOX_PAGE_SIZE, type ProviderInboxTab, type ProviderRfqItem } from '@/lib/rfq/queries'
import { todayIST } from '@/lib/agent/quote-extract'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

// ── FR-11.2 inbox v2 ──────────────────────────────────────────────────────────────
export type InboxRowV3 = ProviderRfqItem & InboxFacts & { neededBy: string | null }

const TAB_OF: Record<ProviderRfqItem['outcome'], ProviderInboxTab> = { open: 'open', quoted: 'quoted', won: 'closed', lost: 'closed', declined: 'closed', withdrawn: 'closed', expired: 'closed', closed: 'closed' }

export interface InboxV3Page {
  items: InboxRowV3[]
  counts: Record<ProviderInboxTab, number>
  page: number
  pageCount: number
  badgeOn: boolean
}

/**
 * The v3 inbox: the provider's OWN matched rows (the same loader as v2), each
 * joined with the RFQ facts a filter reads — budget, needed-by, files, the
 * buyer's state and (only while `buyer_verified_badge_enabled`) one boolean.
 * Filters, search and sort run over those rows in memory, so no parameter
 * can widen what the match returns. Counts reflect the filters.
 */
export async function listProviderInboxV3(userId: string, q: InboxQuery, now: Date = new Date()): Promise<InboxV3Page> {
  const empty: InboxV3Page = { items: [], counts: { open: 0, quoted: 0, closed: 0 }, page: 1, pageCount: 1, badgeOn: false }
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return empty
  const matches = await loadProviderInboxMatches(admin, actor.providerId)
  const ids = matches.map((m) => m.rfqId)
  const badgeOn = (await getAgentSetting(admin, 'buyer_verified_badge_enabled').catch(() => false)) === true
  type Facts = { id: string; msme_id: string; budget_min_paise: number | null; budget_max_paise: number | null; needed_by: string | null; attachments: unknown[] | null; msme: { state: string | null; udyam_verified: boolean; gstin_verified: boolean } | { state: string | null; udyam_verified: boolean; gstin_verified: boolean }[] | null }
  const { data: facts } = ids.length
    ? await admin.from('rfqs').select('id, msme_id, budget_min_paise, budget_max_paise, needed_by, attachments, msme:msme_profiles(state, udyam_verified, gstin_verified)').in('id', ids)
    : { data: [] as Facts[] }
  const byId = new Map(((facts ?? []) as unknown as Facts[]).map((f) => [f.id, f]))
  // D2: at least one paid order with anyone — every orders row exists only after a captured payment.
  const paid = new Set<string>()
  if (badgeOn) {
    const buyers = [...new Set(((facts ?? []) as unknown as Facts[]).map((f) => f.msme_id))]
    if (buyers.length) {
      const { data: o } = await admin.from('orders').select('msme_id').in('msme_id', buyers).limit(5000)
      for (const r of o ?? []) paid.add(r.msme_id as string)
    }
  }
  const rows: InboxRowV3[] = matches.map((m) => {
    const f = byId.get(m.rfqId)
    const b = f ? (Array.isArray(f.msme) ? f.msme[0] : f.msme) : null
    return {
      ...m,
      categorySlug: m.categorySlug,
      buyerState: b?.state ?? null,
      budgetMinPaise: f?.budget_min_paise == null ? null : Number(f.budget_min_paise),
      budgetMaxPaise: f?.budget_max_paise == null ? null : Number(f.budget_max_paise),
      neededBy: f?.needed_by ?? null,
      hasFiles: Array.isArray(f?.attachments) && f.attachments.length > 0,
      buyerVerified: badgeOn && !!b && !!f && isBuyerVerified({ udyamVerified: !!b.udyam_verified, gstinVerified: !!b.gstin_verified, paidOrders: paid.has(f.msme_id) ? 1 : 0 }),
    }
  })
  const filtered = applyInboxQuery(rows, q, now)
  const counts: Record<ProviderInboxTab, number> = { open: 0, quoted: 0, closed: 0 }
  for (const r of filtered) counts[TAB_OF[r.outcome]]++
  const inTab = filtered.filter((r) => TAB_OF[r.outcome] === q.tab)
  const pageCount = Math.max(1, Math.ceil(inTab.length / PROVIDER_INBOX_PAGE_SIZE))
  const page = Math.min(Math.max(1, q.page), pageCount)
  return { items: inTab.slice((page - 1) * PROVIDER_INBOX_PAGE_SIZE, page * PROVIDER_INBOX_PAGE_SIZE), counts, page, pageCount, badgeOn }
}

// ── N29 funnel ────────────────────────────────────────────────────────────────────
export async function getProviderFunnel(admin: Admin, providerId: string, range: FunnelRange): Promise<Funnel> {
  const days = rangeDays(range)
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const sinceDay = new Date(Date.parse(`${todayIST()}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  const [views, matched, quoted, won, declined] = await Promise.all([
    admin.from('view_counts_daily').select('views').eq('provider_id', providerId).gte('day', sinceDay),
    admin.from('rfq_matches').select('rfq_id', { count: 'exact', head: true }).eq('provider_id', providerId).gte('notified_at', since),
    admin.from('quotes').select('id', { count: 'exact', head: true }).eq('provider_id', providerId).gte('created_at', since),
    admin.from('quotes').select('id', { count: 'exact', head: true }).eq('provider_id', providerId).eq('status', QUOTE_STATUS.accepted).gte('created_at', since),
    admin.from('quotes').select('decline_reason').eq('provider_id', providerId).eq('status', QUOTE_STATUS.declined).gte('updated_at', since).not('decline_reason', 'is', null),
  ])
  const v = (views.data ?? []).reduce((a, r) => a + Number(r.views ?? 0), 0)
  return buildFunnel(range, { views: v, matched: matched.count ?? 0, quoted: quoted.count ?? 0, won: won.count ?? 0 }, (declined.data ?? []).map((r) => r.decline_reason as string))
}

// ── FR-11.1 payouts panel ───────────────────────────────────────────────────────────
export interface PayoutsPanel {
  scheduled: { paise: number; next: string | null; n: number }
  held: { paise: number; n: number; reasons: string[] }
  paid30: { paise: number; n: number }
}

/** The existing payouts, summarised (reads only; the ledger stays /partner/earnings). */
export async function getPayoutsPanel(admin: Admin, providerId: string): Promise<PayoutsPanel> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { scheduled, held, paid } = PAYOUT_STATUS
  const { data } = await admin.from('payouts').select('order_id, amount_paise, status, scheduled_for, paid_at').eq('provider_id', providerId).in('status', [scheduled, held, paid])
  const rows = (data ?? []) as { order_id: string; amount_paise: number; status: string; scheduled_for: string | null; paid_at: string | null }[]
  const sch = rows.filter((r) => r.status === scheduled)
  const hld = rows.filter((r) => r.status === held)
  const pd = rows.filter((r) => r.status === paid && r.paid_at && r.paid_at >= since)
  const reasons = new Set<string>()
  if (hld.length) {
    const { data: ev } = await admin.from('order_events').select('payload').in('order_id', hld.map((r) => r.order_id)).eq('event', 'payout_held').order('created_at', { ascending: false }).limit(50)
    for (const e of ev ?? []) for (const r of ((e.payload as { reasons?: string[] } | null)?.reasons ?? [])) reasons.add(r)
  }
  const sum = (xs: typeof rows) => xs.reduce((a, r) => a + Number(r.amount_paise), 0)
  const next = sch.map((r) => r.scheduled_for).filter((d): d is string => !!d).sort()[0] ?? null
  return { scheduled: { paise: sum(sch), next, n: sch.length }, held: { paise: sum(hld), n: hld.length, reasons: [...reasons].slice(0, 3) }, paid30: { paise: sum(pd), n: pd.length } }
}
