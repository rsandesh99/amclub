import { signRfqAttachments } from '@/lib/rfq/attachments'
import 'server-only'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { effectiveCostAfterItcPaise, goodsQuoteMoney, resolveDeclineLocale, rfqQualityDeadline, rfqQualityReportSchema, type ClarificationView, type RfqQualityReport } from '@amclub/shared'
import { RFQ_GOODS_LIST_COLS, QUOTE_GOODS_COLS } from '@/lib/mart/staged-columns'
import { countOpenQuestions, listClarifications, rfqsWithMyOpenQuestion } from '@/lib/rfq/clarifications'
import { getRfqQualityHoldMinutes } from '@/lib/agent/rfq-quality'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RfqListItem {
  id: string
  title: string
  status: string
  /** AMC Mart M2: 'service' | 'goods' (goods carry a Mart category + spec). */
  kind: 'service' | 'goods'
  martCategorySlug: string | null
  quoteCount: number
  maxQuotes: number
  categorySlug: string | null
  createdAt: string
  expiresAt: string
  /** S1.3 — unanswered provider questions (list badge "N questions waiting"); derived, never a status. */
  openQuestions: number
  /** S1.5 — open + fanout_at NULL: the buyer still has quality questions to answer (derived, never a status). */
  deferred: boolean
  /** S1.5 — how many questions the report asked (for the list badge). */
  qualityMissing: number
}

/** Phase 4 — optional commercial terms; null = "not stated" (UI shows a hint, never a blank). */
export interface QuoteTerms {
  gstIncluded: boolean | null
  transportIncluded: boolean | null
  validUntil: string | null
  advancePercent: number | null
}

export function mapQuoteTerms(q: any): QuoteTerms {
  return {
    gstIncluded: q.gst_included ?? null,
    transportIncluded: q.transport_included ?? null,
    validUntil: q.valid_until ?? null,
    advancePercent: q.advance_percent ?? null,
  }
}

/** AMC Mart M2 — goods terms on a quote (null on services quotes). */
export interface QuoteGoodsTerms {
  unitPricePaise: number
  qty: number
  gstRateBps: number
  hsnCode: string
  productId: string | null
  /** Server-computed display money (clients never do money arithmetic — FRONTEND.md §8). */
  taxablePaise: number
  gstPaise: number
  totalInclGstPaise: number
  afterItcPaise: number
  unitInclGstPaise: number
}

export function mapQuoteGoods(q: any): QuoteGoodsTerms | null {
  if (q.unit_price_paise == null || q.qty == null) return null
  const unitPricePaise = Number(q.unit_price_paise)
  const qty = Number(q.qty)
  const gstRateBps = Number(q.gst_rate_bps)
  // S1.2 — the M2 math lives in shared (goodsQuoteMoney) so compareQuotes and display agree byte-for-byte.
  const { taxablePaise, gstPaise, totalInclGstPaise } = goodsQuoteMoney({ unitPricePaise, qty, gstRateBps })
  return {
    unitPricePaise, qty, gstRateBps, hsnCode: q.hsn_code, productId: q.product_id ?? null,
    taxablePaise, gstPaise, totalInclGstPaise,
    afterItcPaise: effectiveCostAfterItcPaise({ taxablePaise }),
    unitInclGstPaise: unitPricePaise + Math.round((unitPricePaise * gstRateBps) / 10000),
  }
}

/** S1.3 — one `quote_events.revised` row, reduced to what the buyer's history popover shows. */
export interface QuoteRevisionRecord {
  revision: number
  at: string
  before: { pricePaise: number; deliveryDays: number }
  after: { pricePaise: number; deliveryDays: number }
}

export interface QuoteForBuyer extends QuoteTerms {
  id: string
  status: string
  goods: QuoteGoodsTerms | null
  pricePaise: number
  deliveryDays: number
  scope: string
  message: string | null
  createdAt: string
  /** S1.2 — part of the pointer-cache key. */
  updatedAt: string | null
  /** S1.2 — why it was declined (buyer reason or another_quote_accepted); never the note. */
  declineReason: string | null
  /** S1.3 — submissions so far (1 = original); revised_at set once revised. */
  revision: number
  revisedAt: string | null
  /** S1.3 — quote_events.revised history (oldest first) so the buyer sees the movement. */
  revisions: QuoteRevisionRecord[]
  provider: {
    id: string; displayName: string; slug: string; avgRating: number; reviewCount: number; completedOrders: number; state: string | null; medianResponseMinutes: number | null; udyamVerified: boolean
    /** S1.2 — the locale a decline message would be written in (languages[] → preferred_locale → en). */
    messageLocale: 'en' | 'hi' | 'ta' | 'te'
  }
}

/**
 * S1.2 — the ONE select for a buyer's quotes (page + compare route share it;
 * staged goods columns stay inside QUOTE_GOODS_COLS). Ordered by price as quoted.
 */
export async function loadBuyerQuotes(admin: Awaited<ReturnType<typeof createAdminClient>>, rfqId: string): Promise<QuoteForBuyer[]> {
  const { data: quotes } = await admin
    .from('quotes')
    .select('id, status, price_paise, delivery_days, scope, message, created_at, updated_at, gst_included, transport_included, valid_until, advance_percent, decline_reason, revision, revised_at' + QUOTE_GOODS_COLS + ', provider:provider_profiles!inner(id, user_id, display_name, slug, avg_rating, review_count, completed_orders, state, median_response_minutes, udyam_verified, languages)')
    .eq('rfq_id', rfqId)
    .order('price_paise', { ascending: true })
  const rows = (quotes ?? []) as any[]
  const userIds = [...new Set(rows.map((q) => q.provider?.user_id).filter(Boolean))] as string[]
  const { data: users } = userIds.length ? await admin.from('users').select('id, preferred_locale').in('id', userIds) : { data: [] }
  const preferred = new Map(((users ?? []) as any[]).map((u) => [u.id, u.preferred_locale as string | null]))
  // S1.3 — revision history only for quotes that were revised (no query otherwise).
  const revisedIds = rows.filter((q) => Number(q.revision ?? 1) > 1).map((q) => q.id as string)
  const history = new Map<string, QuoteRevisionRecord[]>()
  if (revisedIds.length) {
    const { data: evs } = await admin.from('quote_events').select('quote_id, payload, created_at').eq('event_type', 'revised').in('quote_id', revisedIds).order('created_at', { ascending: true })
    for (const e of (evs ?? []) as any[]) {
      const p = (e.payload ?? {}) as { revision?: number; before?: { price_paise?: number; delivery_days?: number }; after?: { price_paise?: number; delivery_days?: number } }
      const rec: QuoteRevisionRecord = {
        revision: Number(p.revision ?? 0), at: e.created_at,
        before: { pricePaise: Number(p.before?.price_paise ?? 0), deliveryDays: Number(p.before?.delivery_days ?? 0) },
        after: { pricePaise: Number(p.after?.price_paise ?? 0), deliveryDays: Number(p.after?.delivery_days ?? 0) },
      }
      history.set(e.quote_id, [...(history.get(e.quote_id) ?? []), rec])
    }
  }
  return rows.map((q: any) => ({
    id: q.id, status: q.status, goods: mapQuoteGoods(q), pricePaise: Number(q.price_paise), deliveryDays: q.delivery_days,
    scope: q.scope, message: q.message, createdAt: q.created_at, updatedAt: q.updated_at ?? null, declineReason: q.decline_reason ?? null,
    revision: Number(q.revision ?? 1), revisedAt: q.revised_at ?? null, revisions: history.get(q.id) ?? [],
    ...mapQuoteTerms(q),
    provider: {
      id: q.provider.id, displayName: q.provider.display_name, slug: q.provider.slug,
      avgRating: Number(q.provider.avg_rating ?? 0), reviewCount: q.provider.review_count ?? 0,
      completedOrders: q.provider.completed_orders ?? 0, state: q.provider.state ?? null,
      medianResponseMinutes: q.provider.median_response_minutes ?? null, udyamVerified: !!q.provider.udyam_verified,
      messageLocale: resolveDeclineLocale(q.provider.languages ?? null, preferred.get(q.provider.user_id) ?? null),
    },
  }))
}

export interface RfqDetailForBuyer {
  id: string
  title: string
  status: string
  details: Record<string, unknown>
  attachments: { url: string; name: string }[]
  budgetMinPaise: number | null
  budgetMaxPaise: number | null
  neededBy: string | null
  categoryId: string | null
  categorySlug: string | null
  kind: 'service' | 'goods'
  martCategorySlug: string | null
  goodsSpec: Record<string, any> | null
  quoteCount: number
  maxQuotes: number
  expiresAt: string
  createdAt: string
  quotes: QuoteForBuyer[]
  /** S1.3 — the clarification thread (unanswered first); the buyer sees who asked. */
  clarifications: ClarificationView[]
  /** S1.5 — deferred = open + fanout_at NULL (derived); the report the buyer saw; when the cron guard releases. */
  quality: RfqQualityState
}

export interface RfqQualityState {
  deferred: boolean
  report: RfqQualityReport | null
  deadlineAt: string | null
  decision: string | null
  checkedAt: string | null
}

/** Buyer's own RFQs (newest first). */
export async function listMyRfqs(userId: string): Promise<RfqListItem[]> {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.msmeId) return []
  const { data } = await admin
    .from('rfqs')
    .select('id, title, status, quote_count, max_quotes, created_at, expires_at, fanout_at, quality_report' + RFQ_GOODS_LIST_COLS + ', category:categories(slug)')
    .eq('msme_id', actor.msmeId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  const rows = (data ?? []) as any[]
  // S1.3 — open questions per RFQ for the "N questions waiting" badge (one query for the whole list).
  const open = await countOpenQuestions(admin, rows.map((r) => r.id as string))
  return rows.map((r: any) => ({
    id: r.id, title: r.title, status: r.status, quoteCount: r.quote_count, maxQuotes: r.max_quotes,
    kind: r.kind === 'goods' ? 'goods' : 'service', martCategorySlug: r.mart_category_slug ?? null,
    categorySlug: r.category?.slug ?? null, createdAt: r.created_at, expiresAt: r.expires_at,
    openQuestions: open.get(r.id) ?? 0,
    // S1.5 — derived: still held for the buyer's answers (fanout_at NULL), never a status.
    deferred: r.status === 'open' && r.fanout_at == null,
    qualityMissing: Array.isArray(r.quality_report?.missing) ? r.quality_report.missing.length : 0,
  }))
}

/** Full RFQ + all quotes (with provider trust signals) for the buyer's compare view. */
export async function getRfqForBuyer(userId: string, rfqId: string): Promise<RfqDetailForBuyer | null> {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.msmeId) return null

  const { data: rfq } = await admin
    .from('rfqs')
    .select('*, category:categories(slug)')
    .eq('id', rfqId)
    .eq('msme_id', actor.msmeId)
    .maybeSingle()
  if (!rfq) return null
  const r = rfq as any

  const [quotes, clarifications] = await Promise.all([loadBuyerQuotes(admin, rfqId), listClarifications(admin, rfqId, { role: 'buyer' })])

  // S1.5 — derived deferred state + the report; the deadline only matters while deferred.
  const deferred = r.status === 'open' && r.fanout_at == null
  const parsedReport = rfqQualityReportSchema.safeParse(r.quality_report)
  const quality: RfqQualityState = {
    deferred,
    report: parsedReport.success ? parsedReport.data : null,
    deadlineAt: deferred ? rfqQualityDeadline(String(r.created_at), await getRfqQualityHoldMinutes(admin)) : null,
    decision: r.quality_decision ?? null,
    checkedAt: r.quality_checked_at ?? null,
  }

  return {
    quality,
    id: r.id, title: r.title, status: r.status, details: r.details ?? {}, attachments: await signRfqAttachments(admin, (r.attachments ?? []) as { url: string; name: string }[]),
    budgetMinPaise: r.budget_min_paise, budgetMaxPaise: r.budget_max_paise, neededBy: r.needed_by,
    categoryId: r.category_id ?? null, categorySlug: r.category?.slug ?? null,
    kind: r.kind === 'goods' ? 'goods' : 'service', martCategorySlug: r.mart_category_slug ?? null, goodsSpec: r.goods_spec ?? null,
    quoteCount: r.quote_count, maxQuotes: r.max_quotes, expiresAt: r.expires_at, createdAt: r.created_at,
    quotes,
    clarifications,
  }
}

export interface ProviderRfqItem {
  rfqId: string
  title: string
  status: string
  kind: 'service' | 'goods'
  martCategorySlug: string | null
  categorySlug: string | null
  quoteCount: number
  maxQuotes: number
  expiresAt: string
  viewed: boolean
  quoted: boolean
  declined: boolean
  /** S1.3 — unanswered questions on the RFQ (all providers) and whether one of them is mine. */
  openQuestions: number
  hasUnansweredMine: boolean
  /** S2.2 — when the match was notified (the quote-or-decline window starts here; Munshi's "new since last scan"). */
  notifiedAt: string | null
}

/** RFQs matched to this provider that are still active (open/quoted). */
export async function listMatchedRfqsForProvider(userId: string): Promise<ProviderRfqItem[]> {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return []

  const { data: matches } = await admin
    .from('rfq_matches')
    .select('rfq_id, viewed_at, declined_at, notified_at, rfq:rfqs!inner(id, title, status, quote_count, max_quotes, expires_at' + RFQ_GOODS_LIST_COLS + ', category:categories(slug))')
    .eq('provider_id', actor.providerId)
    .order('notified_at', { ascending: false })
  if (!matches) return []

  // Which of these has this provider already quoted on?
  const rfqIds = matches.map((m: any) => m.rfq_id)
  const quotedSet = new Set<string>()
  if (rfqIds.length) {
    const { data: myQuotes } = await admin.from('quotes').select('rfq_id').eq('provider_id', actor.providerId).in('rfq_id', rfqIds)
    for (const q of myQuotes ?? []) quotedSet.add((q as any).rfq_id)
  }
  // S1.3 — open questions per RFQ + "one of them is mine" (two queries for the whole list).
  const [open, mineOpen] = await Promise.all([countOpenQuestions(admin, rfqIds), rfqsWithMyOpenQuestion(admin, rfqIds, actor.providerId)])

  return (matches as any[])
    .filter((m) => m.rfq && (m.rfq.status === 'open' || m.rfq.status === 'quoted'))
    .map((m) => ({
      rfqId: m.rfq_id, title: m.rfq.title, status: m.rfq.status, kind: m.rfq.kind === 'goods' ? 'goods' : 'service', martCategorySlug: m.rfq.mart_category_slug ?? null, categorySlug: m.rfq.category?.slug ?? null,
      quoteCount: m.rfq.quote_count, maxQuotes: m.rfq.max_quotes, expiresAt: m.rfq.expires_at,
      viewed: !!m.viewed_at, quoted: quotedSet.has(m.rfq_id), declined: !!m.declined_at,
      openQuestions: open.get(m.rfq_id) ?? 0, hasUnansweredMine: mineOpen.has(m.rfq_id),
      notifiedAt: m.notified_at ?? null,
    }))
}

export interface RfqDetailForProvider {
  id: string
  title: string
  status: string
  details: Record<string, unknown>
  attachments: { url: string; name: string }[]
  budgetMinPaise: number | null
  budgetMaxPaise: number | null
  neededBy: string | null
  categorySlug: string | null
  kind: 'service' | 'goods'
  martCategorySlug: string | null
  goodsSpec: Record<string, any> | null
  quoteCount: number
  maxQuotes: number
  expiresAt: string
  canQuote: boolean
  /** S0.4: set when this provider declined the match (or the window lapsed). */
  declinedAt: string | null
  myQuote: ({ id: string; pricePaise: number; deliveryDays: number; scope: string; message: string | null; status: string; goods: QuoteGoodsTerms | null; declineReason: string | null; declineMessage: string | null; revision: number; revisedAt: string | null } & QuoteTerms) | null
  /** S1.3 — the whole thread (every provider's questions); `mine` marks this provider's. Never a provider id. */
  clarifications: ClarificationView[]
}

/** RFQ detail for a matched provider; marks viewed_at on open. */
export async function getRfqForProvider(userId: string, rfqId: string): Promise<RfqDetailForProvider | null> {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return null

  const { data: match } = await admin
    .from('rfq_matches')
    .select('viewed_at, declined_at')
    .eq('rfq_id', rfqId)
    .eq('provider_id', actor.providerId)
    .maybeSingle()
  if (!match) return null

  // Mark viewed (first open).
  if (!match.viewed_at) {
    await admin.from('rfq_matches').update({ viewed_at: new Date().toISOString() }).eq('rfq_id', rfqId).eq('provider_id', actor.providerId)
  }

  const { data: rfq } = await admin.from('rfqs').select('*, category:categories(slug)').eq('id', rfqId).maybeSingle()
  if (!rfq) return null
  const r = rfq as any

  const [{ data: myQuote }, clarifications] = await Promise.all([
    admin
      .from('quotes')
      .select('id, price_paise, delivery_days, scope, message, status, gst_included, transport_included, valid_until, advance_percent, decline_reason, decline_message, revision, revised_at' + QUOTE_GOODS_COLS)
      .eq('rfq_id', rfqId)
      .eq('provider_id', actor.providerId)
      .maybeSingle(),
    listClarifications(admin, rfqId, { role: 'provider', providerId: actor.providerId }),
  ])

  const active = r.status === 'open' || r.status === 'quoted'
  const slotsLeft = r.quote_count < r.max_quotes
  const notExpired = new Date(r.expires_at).getTime() > Date.now()

  return {
    id: r.id, title: r.title, status: r.status, details: r.details ?? {}, attachments: await signRfqAttachments(admin, (r.attachments ?? []) as { url: string; name: string }[]),
    budgetMinPaise: r.budget_min_paise, budgetMaxPaise: r.budget_max_paise, neededBy: r.needed_by,
    categorySlug: r.category?.slug ?? null,
    kind: r.kind === 'goods' ? 'goods' : 'service', martCategorySlug: r.mart_category_slug ?? null, goodsSpec: r.goods_spec ?? null,
    quoteCount: r.quote_count, maxQuotes: r.max_quotes, expiresAt: r.expires_at,
    canQuote: active && slotsLeft && notExpired && !myQuote && !match.declined_at,
    declinedAt: (match as any).declined_at ?? null,
    myQuote: myQuote ? { id: (myQuote as any).id, pricePaise: Number((myQuote as any).price_paise), deliveryDays: (myQuote as any).delivery_days, scope: (myQuote as any).scope, message: (myQuote as any).message ?? null, status: (myQuote as any).status, goods: mapQuoteGoods(myQuote), declineReason: (myQuote as any).decline_reason ?? null, declineMessage: (myQuote as any).decline_message ?? null, revision: Number((myQuote as any).revision ?? 1), revisedAt: (myQuote as any).revised_at ?? null, ...mapQuoteTerms(myQuote) } : null,
    clarifications,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
