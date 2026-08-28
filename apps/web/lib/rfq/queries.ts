import 'server-only'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RfqListItem {
  id: string
  title: string
  status: string
  quoteCount: number
  maxQuotes: number
  categorySlug: string | null
  createdAt: string
  expiresAt: string
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

export interface QuoteForBuyer extends QuoteTerms {
  id: string
  status: string
  pricePaise: number
  deliveryDays: number
  scope: string
  message: string | null
  createdAt: string
  provider: { id: string; displayName: string; slug: string; avgRating: number; reviewCount: number; completedOrders: number; state: string | null }
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
  categoryId: string
  categorySlug: string | null
  quoteCount: number
  maxQuotes: number
  expiresAt: string
  createdAt: string
  quotes: QuoteForBuyer[]
}

/** Buyer's own RFQs (newest first). */
export async function listMyRfqs(userId: string): Promise<RfqListItem[]> {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.msmeId) return []
  const { data } = await admin
    .from('rfqs')
    .select('id, title, status, quote_count, max_quotes, created_at, expires_at, category:categories(slug)')
    .eq('msme_id', actor.msmeId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  return (data ?? []).map((r: any) => ({
    id: r.id, title: r.title, status: r.status, quoteCount: r.quote_count, maxQuotes: r.max_quotes,
    categorySlug: r.category?.slug ?? null, createdAt: r.created_at, expiresAt: r.expires_at,
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

  const { data: quotes } = await admin
    .from('quotes')
    .select('id, status, price_paise, delivery_days, scope, message, created_at, gst_included, transport_included, valid_until, advance_percent, provider:provider_profiles!inner(id, display_name, slug, avg_rating, review_count, completed_orders, state)')
    .eq('rfq_id', rfqId)
    .order('price_paise', { ascending: true })

  return {
    id: r.id, title: r.title, status: r.status, details: r.details ?? {}, attachments: r.attachments ?? [],
    budgetMinPaise: r.budget_min_paise, budgetMaxPaise: r.budget_max_paise, neededBy: r.needed_by,
    categoryId: r.category_id, categorySlug: r.category?.slug ?? null,
    quoteCount: r.quote_count, maxQuotes: r.max_quotes, expiresAt: r.expires_at, createdAt: r.created_at,
    quotes: (quotes ?? []).map((q: any) => ({
      id: q.id, status: q.status, pricePaise: Number(q.price_paise), deliveryDays: q.delivery_days,
      scope: q.scope, message: q.message, createdAt: q.created_at,
      ...mapQuoteTerms(q),
      provider: {
        id: q.provider.id, displayName: q.provider.display_name, slug: q.provider.slug,
        avgRating: Number(q.provider.avg_rating ?? 0), reviewCount: q.provider.review_count ?? 0,
        completedOrders: q.provider.completed_orders ?? 0, state: q.provider.state ?? null,
      },
    })),
  }
}

export interface ProviderRfqItem {
  rfqId: string
  title: string
  status: string
  categorySlug: string | null
  quoteCount: number
  maxQuotes: number
  expiresAt: string
  viewed: boolean
  quoted: boolean
}

/** RFQs matched to this provider that are still active (open/quoted). */
export async function listMatchedRfqsForProvider(userId: string): Promise<ProviderRfqItem[]> {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return []

  const { data: matches } = await admin
    .from('rfq_matches')
    .select('rfq_id, viewed_at, rfq:rfqs!inner(id, title, status, quote_count, max_quotes, expires_at, category:categories(slug))')
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

  return (matches as any[])
    .filter((m) => m.rfq && (m.rfq.status === 'open' || m.rfq.status === 'quoted'))
    .map((m) => ({
      rfqId: m.rfq_id, title: m.rfq.title, status: m.rfq.status, categorySlug: m.rfq.category?.slug ?? null,
      quoteCount: m.rfq.quote_count, maxQuotes: m.rfq.max_quotes, expiresAt: m.rfq.expires_at,
      viewed: !!m.viewed_at, quoted: quotedSet.has(m.rfq_id),
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
  quoteCount: number
  maxQuotes: number
  expiresAt: string
  canQuote: boolean
  myQuote: ({ id: string; pricePaise: number; deliveryDays: number; scope: string; status: string } & QuoteTerms) | null
}

/** RFQ detail for a matched provider; marks viewed_at on open. */
export async function getRfqForProvider(userId: string, rfqId: string): Promise<RfqDetailForProvider | null> {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return null

  const { data: match } = await admin
    .from('rfq_matches')
    .select('viewed_at')
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

  const { data: myQuote } = await admin
    .from('quotes')
    .select('id, price_paise, delivery_days, scope, status, gst_included, transport_included, valid_until, advance_percent')
    .eq('rfq_id', rfqId)
    .eq('provider_id', actor.providerId)
    .maybeSingle()

  const active = r.status === 'open' || r.status === 'quoted'
  const slotsLeft = r.quote_count < r.max_quotes
  const notExpired = new Date(r.expires_at).getTime() > Date.now()

  return {
    id: r.id, title: r.title, status: r.status, details: r.details ?? {}, attachments: r.attachments ?? [],
    budgetMinPaise: r.budget_min_paise, budgetMaxPaise: r.budget_max_paise, neededBy: r.needed_by,
    categorySlug: r.category?.slug ?? null, quoteCount: r.quote_count, maxQuotes: r.max_quotes, expiresAt: r.expires_at,
    canQuote: active && slotsLeft && notExpired && !myQuote,
    myQuote: myQuote ? { id: (myQuote as any).id, pricePaise: Number((myQuote as any).price_paise), deliveryDays: (myQuote as any).delivery_days, scope: (myQuote as any).scope, status: (myQuote as any).status, ...mapQuoteTerms(myQuote) } : null,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
