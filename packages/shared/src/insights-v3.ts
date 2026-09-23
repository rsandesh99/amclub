import { z } from 'zod'

/**
 * PRD Experience v3 E11 FR-11.5 (N29 / N22) — the provider's insights.
 * Privacy rules live here so every surface applies the same ones:
 *   - a loss delta shows only with n ≥ 5 (INSIGHT_DELTA_MIN_N);
 *   - decline reasons only with n ≥ 3 (DECLINE_REASON_MIN_N, partner-v3.ts);
 *   - deltas only — never another provider's name or price;
 *   - never the composite AMC Score (that stays on the score card).
 */
export const INSIGHT_DELTA_MIN_N = 5

export interface LossPair {
  /** My normalised all-in total and delivery days on an RFQ I lost. */
  mine: { totalPaise: number; deliveryDays: number | null }
  /** The accepted quote on the same RFQ (read server-side; only the delta leaves). */
  winner: { totalPaise: number; deliveryDays: number | null }
}

export const lossInsightSchema = z.object({
  /** Losses where I was dearer: count, of all losses with a winner, median % dearer (null below n 5). */
  price: z.object({ n: z.number().int(), of: z.number().int(), medianPct: z.number().int().nullable() }),
  /** Losses where I was slower: count, of all, median days slower (null below n 5). */
  delivery: z.object({ n: z.number().int(), of: z.number().int(), medianDays: z.number().int().nullable() }),
})
export type LossInsight = z.infer<typeof lossInsightSchema>

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** "You lost 6 of 9 on price, by a median of 12 %" — counts always, the median only with n ≥ 5. */
export function lossInsight(pairs: readonly LossPair[]): LossInsight {
  const pricePct = pairs
    .filter((p) => p.winner.totalPaise > 0 && p.mine.totalPaise > p.winner.totalPaise)
    .map((p) => ((p.mine.totalPaise - p.winner.totalPaise) * 100) / p.winner.totalPaise)
  const slower = pairs
    .filter((p) => p.mine.deliveryDays != null && p.winner.deliveryDays != null && p.mine.deliveryDays > p.winner.deliveryDays)
    .map((p) => p.mine.deliveryDays! - p.winner.deliveryDays!)
  return {
    price: { n: pricePct.length, of: pairs.length, medianPct: pricePct.length >= INSIGHT_DELTA_MIN_N ? Math.round(median(pricePct)) : null },
    delivery: { n: slower.length, of: pairs.length, medianDays: slower.length >= INSIGHT_DELTA_MIN_N ? Math.round(median(slower)) : null },
  }
}

/** Monday (IST) of the week holding `iso`, as YYYY-MM-DD — the weekly funnel's bucket. */
export function istWeekStart(iso: string): string {
  const ist = new Date(Date.parse(iso) + 5.5 * 3600 * 1000)
  const dow = (ist.getUTCDay() + 6) % 7 // Monday = 0
  const monday = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - dow * 86_400_000
  return new Date(monday).toISOString().slice(0, 10)
}

export interface WeekCounts { week: string; views: number; matched: number; quoted: number; won: number }

/** The last `weeks` IST weeks (oldest first), zero-filled. */
export function weeklyBuckets(nowIso: string, weeks: number, events: { views: { day: string; n: number }[]; matched: string[]; quoted: string[]; won: string[] }): WeekCounts[] {
  const thisWeek = istWeekStart(nowIso)
  const keys: string[] = []
  for (let i = weeks - 1; i >= 0; i--) keys.push(new Date(Date.parse(`${thisWeek}T00:00:00Z`) - i * 7 * 86_400_000).toISOString().slice(0, 10))
  const out = new Map(keys.map((k) => [k, { week: k, views: 0, matched: 0, quoted: 0, won: 0 }]))
  for (const v of events.views) {
    const b = out.get(istWeekStart(`${v.day}T06:30:00Z`)) // noon IST that day
    if (b) b.views += v.n
  }
  for (const [key, list] of [['matched', events.matched], ['quoted', events.quoted], ['won', events.won]] as const) {
    for (const t of list) { const b = out.get(istWeekStart(t)); if (b) b[key]++ }
  }
  return keys.map((k) => out.get(k)!)
}

// ── FR-11.6 GeM checklist freshness ───────────────────────────────────────────────
/** Reviewed content hides itself this many days after its last review, until re-reviewed. */
export const CONTENT_REVIEW_TTL_DAYS = 180
export function isReviewFresh(reviewedAt: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!reviewedAt) return false
  const t = Date.parse(reviewedAt)
  return Number.isFinite(t) && nowMs - t <= CONTENT_REVIEW_TTL_DAYS * 86_400_000
}

// ── FR-11.6 tenders (D9, dark) ─────────────────────────────────────────────────────
export const TENDER_VERDICTS = ['saved', 'not_relevant'] as const
export const tenderFeedbackSchema = z.object({ verdict: z.enum(TENDER_VERDICTS) }).strict()
export const TENDER_VALUE_BANDS = ['under_5l', '5l_to_25l', '25l_to_1cr', 'over_1cr'] as const
export type TenderValueBand = (typeof TENDER_VALUE_BANDS)[number]
