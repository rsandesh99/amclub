import 'server-only'
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  compareQuotes,
  comparePointersCacheSchema,
  comparePointersSchema,
  sanitizePointers,
  type CompareQuoteInput,
  type CompareQuoteResult,
  type ComparePointersCache,
  type PointerLocale,
} from '@amclub/shared'
import { buildComparePointerParts, stubComparePointers } from '@amclub/agent-core'
import type { QuoteForBuyer } from './queries'
import { AGENT_ENABLED } from '@/lib/flags'
import { isAgentEnabledForUser } from '@/lib/agent/settings'
import { BudgetExceededError, boundedChatJson } from '@/lib/agent/bounded'
import { todayIST } from '@/lib/agent/quote-extract'

/**
 * Buyer compare (S1.2 §5). Flags + normalised totals are `compareQuotes`
 * (shared, deterministic) over the same rows the page reads — never a model.
 * Pointers are the ONLY model work: a bounded call (run_id null) behind
 * AGENT_ENABLED + agents_enabled.compare_pointers + cohort, cached one slot per
 * RFQ on `rfqs.compare_pointers` keyed by a hash of the quote set + locale, and
 * passed through the banned-phrase gate before anything is stored. No
 * ai_decisions row: pointers are read-only advice, nothing is confirmed.
 */

export function toCompareInputs(kind: 'service' | 'goods', quotes: readonly QuoteForBuyer[]): CompareQuoteInput[] {
  return quotes.map((q) => ({
    id: q.id,
    kind,
    pricePaise: q.pricePaise,
    deliveryDays: q.deliveryDays,
    gstIncluded: q.gstIncluded,
    transportIncluded: q.transportIncluded,
    validUntil: q.validUntil,
    advancePercent: q.advancePercent,
    goods: q.goods ? { unitPricePaise: q.goods.unitPricePaise, qty: q.goods.qty, gstRateBps: q.goods.gstRateBps } : null,
  }))
}

/** Flags do not depend on any flag: pure function of the quotes. */
export function computeCompare(kind: 'service' | 'goods', quotes: readonly QuoteForBuyer[], today = todayIST()): CompareQuoteResult[] {
  return compareQuotes(toCompareInputs(kind, quotes), { today })
}

export function toPointerLocale(locale: string | null | undefined): PointerLocale {
  return locale === 'hi' || locale === 'ta' || locale === 'te' ? locale : 'en'
}

/** sha256 over the sorted quote ids + their updated_at + locale — the one-slot cache key. */
export function pointersHash(quotes: readonly Pick<QuoteForBuyer, 'id' | 'updatedAt'>[], locale: PointerLocale): string {
  const parts = [...quotes].sort((a, b) => a.id.localeCompare(b.id)).map((q) => `${q.id}@${q.updatedAt ?? ''}`)
  return createHash('sha256').update(`${parts.join('|')}|${locale}`).digest('hex')
}

export type PointerSource = 'cached' | 'fresh' | 'off' | 'error' | 'skipped'

export interface PointersOutcome {
  pointers: ComparePointersCache | null
  source: PointerSource
  error?: 'budget_exceeded' | 'unavailable'
  dropped?: string[]
}

export async function isComparePointersEnabledFor(admin: SupabaseClient, userId: string): Promise<boolean> {
  if (!AGENT_ENABLED) return false
  return isAgentEnabledForUser(admin, 'compare_pointers', userId)
}

/**
 * Cached pointers for this RFQ + locale, or — when `allowModel` — a fresh
 * bounded call. `allowModel=false` is the page's server render (never waits on
 * the model); the compare route passes true after its rate limit.
 */
export async function getComparePointers(
  admin: SupabaseClient,
  args: { rfqId: string; kind: 'service' | 'goods'; quotes: readonly QuoteForBuyer[]; results: readonly CompareQuoteResult[]; userId: string; locale: PointerLocale; allowModel: boolean; today?: string },
): Promise<PointersOutcome> {
  if (!(await isComparePointersEnabledFor(admin, args.userId))) return { pointers: null, source: 'off' }
  if (args.quotes.length < 2) return { pointers: null, source: 'skipped' }
  const hash = pointersHash(args.quotes, args.locale)

  const { data: row } = await admin.from('rfqs').select('compare_pointers').eq('id', args.rfqId).maybeSingle()
  const cached = comparePointersCacheSchema.safeParse((row as { compare_pointers?: unknown } | null)?.compare_pointers)
  if (cached.success && cached.data.hash === hash && cached.data.locale === args.locale) return { pointers: cached.data, source: 'cached' }
  if (!args.allowModel) return { pointers: null, source: 'skipped' }

  const today = args.today ?? todayIST()
  const parts = buildComparePointerParts({
    locale: args.locale,
    today,
    quotes: args.quotes.map((q) => ({
      id: q.id,
      kind: args.kind,
      pricePaise: q.pricePaise,
      deliveryDays: q.deliveryDays,
      gstIncluded: q.gstIncluded,
      transportIncluded: q.transportIncluded,
      validUntil: q.validUntil,
      advancePercent: q.advancePercent,
      goods: q.goods ? { unitPricePaise: q.goods.unitPricePaise, qty: q.goods.qty, gstRateBps: q.goods.gstRateBps } : null,
      medianResponseMinutes: q.provider.medianResponseMinutes,
      completedOrders: q.provider.completedOrders,
    })),
    results: args.results,
  })
  try {
    const res = await boundedChatJson(admin, {
      userId: args.userId,
      feature: 'compare_pointers',
      taskClass: 'quote_compare',
      promptId: 'quote_compare',
      promptVersion: 'v1',
      schema: comparePointersSchema,
      parts,
      temperature: 0.2,
      stub: () => stubComparePointers({ results: args.results, locale: args.locale }),
      meta: { rfq_id: args.rfqId, locale: args.locale, quote_count: args.quotes.length },
    })
    // Runtime gate: unknown ids dropped; any banned phrase drops that quote's lines; a hit is never stored.
    const known = new Set(args.quotes.map((q) => q.id))
    const filtered = { pointers: res.data.pointers.filter((p) => known.has(p.quote_id)) }
    const { pointers, dropped } = sanitizePointers(filtered, args.locale)
    if (dropped.length) console.warn('[compare-pointers] banned_hit', { rfq_id: args.rfqId, dropped })
    const cache: ComparePointersCache = { hash, locale: args.locale, pointers: pointers.pointers, model: res.model, stub: res.stub, created_at: new Date().toISOString() }
    await admin.from('rfqs').update({ compare_pointers: cache, compare_pointers_at: cache.created_at }).eq('id', args.rfqId)
    return { pointers: cache, source: 'fresh', ...(dropped.length ? { dropped } : {}) }
  } catch (e) {
    if (e instanceof BudgetExceededError) return { pointers: null, source: 'error', error: 'budget_exceeded' }
    console.error('[compare-pointers] gateway', (e as Error).message)
    return { pointers: null, source: 'error', error: 'unavailable' }
  }
}
