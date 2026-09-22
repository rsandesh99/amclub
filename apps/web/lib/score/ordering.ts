import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SCORE_VERSION, compareOrdering, priceOrder, type CompareOrdering, type CompareQuoteResult } from '@amclub/shared'
import { captureServerEvent } from '@/lib/analytics/server'
import { getScoreSettings } from '@/lib/score/settings'
import type { QuoteForBuyer } from '@/lib/rfq/queries'

/**
 * S2.4 — the compare screen's order (ADR-010 §7). Reliability-adjusted only when `reliability_rank_enabled`, ≥ 2
 * quotes and the largest normalised total reaches `reliability_rank_threshold_paise` (services only); otherwise the
 * price order, byte-identical to the screen's own price sort. The scores are read HERE, server-side, and never leave:
 * the result is `{ mode, ids }`.
 */
export async function compareOrderingFor(
  admin: SupabaseClient,
  args: { kind: 'service' | 'goods'; quotes: readonly QuoteForBuyer[]; results: readonly CompareQuoteResult[]; userId?: string | null; rfqId?: string | null },
): Promise<CompareOrdering> {
  const totals = new Map(args.results.map((r) => [r.id, r.normalizedTotalPaise]))
  const base = args.quotes.map((q) => ({ id: q.id, providerId: q.provider.id, normalizedTotalPaise: totals.get(q.id) ?? q.pricePaise }))
  const settings = await getScoreSettings(admin)
  const max = base.reduce((m, q) => Math.max(m, q.normalizedTotalPaise), 0)
  let ordering: CompareOrdering
  if (args.kind === 'goods' || !settings.rankEnabled || base.length < 2 || max < settings.rankThresholdPaise) {
    ordering = { mode: 'price', ids: priceOrder(base) }
  } else {
    const { data } = await admin.from('provider_scores').select('provider_id, score, gated').eq('score_version', SCORE_VERSION).in('provider_id', [...new Set(base.map((q) => q.providerId))])
    const scores = new Map(((data ?? []) as { provider_id: string; score: number | null; gated: boolean }[]).map((r) => [r.provider_id, r.gated ? null : r.score]))
    ordering = compareOrdering(
      base.map((q) => ({ id: q.id, normalizedTotalPaise: q.normalizedTotalPaise, providerScore: scores.get(q.providerId) ?? null })),
      { enabled: true, thresholdPaise: settings.rankThresholdPaise, nullPrior: settings.nullPrior, kBps: settings.rankKBps },
    )
  }
  if (args.userId) {
    const reordered = ordering.mode === 'reliability' && ordering.ids.join(',') !== priceOrder(base).join(',')
    captureServerEvent(args.userId, 'compare_ordering', { rfq_id: args.rfqId ?? null, mode: ordering.mode, quote_count: base.length, reordered })
  }
  return ordering
}
