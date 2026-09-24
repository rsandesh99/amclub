import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { PAYOUT_RELEASE_STATUSES, type OrderStatus } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { bankFacts, payoutReadiness } from '@/lib/payments/readiness'
import { consentRate } from '@amclub/shared'
import { ANALYTICS_CONSENT_REQUIRED } from '@/lib/public-flags'
import { MART_ENABLED } from '@/lib/flags'

/* eslint-disable @typescript-eslint/no-explicit-any */

// "Value delivered" states = the payout-release set plus post-review (§2.5 rule 8).
const COMPLETED: readonly OrderStatus[] = [...PAYOUT_RELEASE_STATUSES, 'reviewed']

/**
 * Operating dashboard metrics (A5). Financial metrics + funnels are computed
 * from the DB (authoritative, no PostHog dependency); aggregation is in JS over
 * pilot-scale data. The category × state active-provider matrix is the §7.3
 * liquidity instrument. Date range (?from&?to ISO) filters the flow metrics;
 * supply counts (providers, liquidity) are point-in-time.
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const sp = new URL(request.url).searchParams
  const from = sp.get('from') ?? new Date(Date.now() - 30 * 86400000).toISOString()
  const to = sp.get('to') ?? new Date().toISOString()

  const admin = await createAdminClient()

  const [ordersRes, sessionsRes, rfqsRes, disputesRes, providersRes, provCatsRes, catsRes, heartbeatsRes] = await Promise.all([
    admin.from('orders').select('status, total_paise, commission_paise, msme_id').gte('created_at', from).lte('created_at', to),
    admin.from('checkout_sessions').select('id', { count: 'exact', head: true }).gte('created_at', from).lte('created_at', to),
    admin.from('rfqs').select('status').gte('created_at', from).lte('created_at', to),
    admin.from('disputes').select('id', { count: 'exact', head: true }).gte('created_at', from).lte('created_at', to),
    admin.from('provider_profiles').select('id, state, status').is('deleted_at', null),
    admin.from('provider_categories').select('provider_id, category_id'),
    admin.from('categories').select('id, slug, name_i18n'),
    // Cron liveness + outcome (STATUS_AUDIT B3, audit M35) — dead or failing crons must be visible, not silent.
    // `*`: status / summary arrive with migration 0080; before it the rows still load (and read as ok).
    admin.from('cron_heartbeats').select('*'),
  ])

  const orders = (ordersRes.data ?? []) as any[]
  const gmvPaise = orders.reduce((s, o) => s + Number(o.total_paise), 0)
  const commissionPaise = orders.reduce((s, o) => s + Number(o.commission_paise), 0)
  const completedOrders = orders.filter((o) => COMPLETED.includes(o.status)).length
  const totalOrders = orders.length
  const takeRateBps = gmvPaise > 0 ? Math.round((commissionPaise / gmvPaise) * 10000) : 0

  // Conversion funnel (DB): checkout sessions started → orders materialised (paid).
  const sessions = sessionsRes.count ?? 0
  const conversionPct = sessions > 0 ? Math.round((totalOrders / sessions) * 1000) / 10 : 0

  // RFQ funnel + quote-response rate.
  const rfqs = (rfqsRes.data ?? []) as any[]
  const rfqsCreated = rfqs.length
  const rfqsQuoted = rfqs.filter((r) => r.status === 'quoted' || r.status === 'accepted').length
  const rfqsAccepted = rfqs.filter((r) => r.status === 'accepted').length
  const quoteResponseRatePct = rfqsCreated > 0 ? Math.round((rfqsQuoted / rfqsCreated) * 1000) / 10 : 0

  // Dispute rate + repeat-purchase rate.
  const disputeCount = disputesRes.count ?? 0
  const disputeRatePct = totalOrders > 0 ? Math.round((disputeCount / totalOrders) * 1000) / 10 : 0
  const ordersByMsme = new Map<string, number>()
  for (const o of orders) ordersByMsme.set(o.msme_id, (ordersByMsme.get(o.msme_id) ?? 0) + 1)
  const buyers = ordersByMsme.size
  const repeatBuyers = [...ordersByMsme.values()].filter((n) => n >= 2).length
  const repeatPurchaseRatePct = buyers > 0 ? Math.round((repeatBuyers / buyers) * 1000) / 10 : 0

  // Supply liquidity (point-in-time): active providers, category × state matrix.
  const providers = (providersRes.data ?? []) as any[]
  const activeProviders = providers.filter((p) => p.status === 'active')
  // Phase 3b — payout readiness of the ACTIVE supply: the founder's Route/bank
  // worklist, filled the moment a provider is approved.
  const activeIds = activeProviders.map((p) => p.id)
  const { data: bankRows } = activeIds.length
    ? await admin.from('provider_bank_accounts').select('provider_id, penny_drop_verified, razorpay_route_account_id').in('provider_id', activeIds)
    : { data: [] as { provider_id: string; penny_drop_verified: boolean; razorpay_route_account_id: string | null }[] }
  const bankByProvider = new Map((bankRows ?? []).map((b) => [b.provider_id, b]))
  const providersReady = activeIds.filter((id) => payoutReadiness(bankFacts(bankByProvider.get(id))) === 'ready').length
  const providersNotReady = activeIds.length - providersReady
  const provState = new Map(providers.map((p) => [p.id, { state: p.state, active: p.status === 'active' }]))
  const cats = (catsRes.data ?? []) as any[]
  const catById = new Map(cats.map((c) => [c.id, c]))

  const matrix: Record<string, Record<string, number>> = {} // catSlug → state → count
  const byCategory: Record<string, number> = {}
  const byState: Record<string, number> = {}
  for (const pc of (provCatsRes.data ?? []) as any[]) {
    const prov = provState.get(pc.provider_id)
    const cat = catById.get(pc.category_id)
    if (!prov?.active || !cat || !prov.state) continue
    const slug = cat.slug as string
    matrix[slug] = matrix[slug] ?? {}
    matrix[slug][prov.state] = (matrix[slug][prov.state] ?? 0) + 1
    byCategory[slug] = (byCategory[slug] ?? 0) + 1
    byState[prov.state] = (byState[prov.state] ?? 0) + 1
  }
  const topCategories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([slug, count]) => ({ slug, name: catById.get(cats.find((c) => c.slug === slug)?.id)?.name_i18n?.en ?? slug, count }))
  const topStates = Object.entries(byState).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([state, count]) => ({ state, count }))

  // E17 (N36) — the consent rate is its own metric, counted from stored choices (never from analytics).
  // Only while consent is required; a tolerant read (the column arrives with 0068).
  let analyticsConsent: { granted: number; denied: number; rate: number | null } | null = null
  if (ANALYTICS_CONSENT_REQUIRED) {
    const { data: rows, error } = await admin.from('users').select('analytics_consent').not('analytics_consent', 'is', null).limit(50000)
    if (!error) analyticsConsent = consentRate((rows ?? []).map((r) => (r as { analytics_consent: unknown }).analytics_consent))
  }

  return NextResponse.json({
    range: { from, to },
    ...(analyticsConsent ? { analyticsConsent } : {}),
    financial: { gmvPaise, commissionPaise, takeRateBps, completedOrders, totalOrders },
    funnel: { checkoutSessions: sessions, ordersPlaced: totalOrders, conversionPct },
    rfq: { rfqsCreated, rfqsQuoted, rfqsAccepted, quoteResponseRatePct },
    health: { disputeCount, disputeRatePct, repeatPurchaseRatePct, activeProviders: activeProviders.length, providersReady, providersNotReady },
    topCategories,
    topStates,
    liquidityMatrix: { categories: Object.keys(matrix).sort(), states: [...new Set(Object.values(matrix).flatMap((m) => Object.keys(m)))].sort(), matrix },
    cronHeartbeats: heartbeatsRes.data ?? [],
    // Which flag-gated crons are expected to beat (pool-close records nothing while Mart is off).
    cronExpect: { mart: MART_ENABLED },
  })
}
/* eslint-enable @typescript-eslint/no-explicit-any */
