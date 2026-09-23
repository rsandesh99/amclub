import { z } from 'zod'
import { rfqQualityPrecheck, type RfqQualityPrecheckInput, type RfqQualityPrecheckResult, type RfqQualityGap, type RfqQualityRisk } from './rfq-quality'
import { SEARCH_CREDENTIALS } from './search-v2'
import { CATEGORY_SLUGS } from './categories'
import { ALL_SPECIALIZATIONS } from './specializations'

/**
 * Experience v3 E6 (PRD FR-6.2 / 6.4 / 6.5 / 6.6) — the requirement form's
 * shared rules.
 */

// ── FR-6.2 (N19) strength meter — the SAME rules as the server pre-check ────────

/** What each pre-check finding costs the score (and so what fixing it gains). */
export const RFQ_SCORE_PENALTY = {
  required: 15,
  gap: { quantity: 8, location: 10, timeline: 10, budget: 8, specs: 10 } satisfies Record<RfqQualityGap, number>,
  risk: { contact_info_in_text: 20, title_too_vague: 10, description_too_short: 10, budget_below_floor: 5, duplicate_recent: 0 } satisfies Record<RfqQualityRisk, number>,
} as const

export type RfqScoreField = string // a template field name, or one of the generic targets below
export const RFQ_SCORE_TARGETS = { timeline: 'needed_by', budget: 'budget', specs: 'description', quantity: 'quantity', location: 'location', title_too_vague: 'title', description_too_short: 'description', contact_info_in_text: 'remove_contact', budget_below_floor: 'budget', duplicate_recent: 'title' } as const

export interface RfqQualityScore {
  score: number
  /** The single change that would raise the score most (null when nothing is left). */
  next: { field: RfqScoreField; gain: number; reason: string } | null
  bucket: 'weak' | 'fair' | 'good' | 'strong'
}

/** Score 0–100 from a pre-check result (exported for the agreement test). */
export function scoreFromPrecheck(pre: RfqQualityPrecheckResult): RfqQualityScore {
  const items: { field: string; gain: number; reason: string }[] = [
    ...pre.missingRequired.map((f) => ({ field: f, gain: RFQ_SCORE_PENALTY.required, reason: 'required' })),
    ...pre.gaps.map((g) => ({ field: RFQ_SCORE_TARGETS[g], gain: RFQ_SCORE_PENALTY.gap[g], reason: g })),
    ...pre.risks.map((r) => ({ field: RFQ_SCORE_TARGETS[r], gain: RFQ_SCORE_PENALTY.risk[r], reason: r })),
  ].filter((x) => x.gain > 0)
  const score = Math.max(0, Math.min(100, 100 - items.reduce((s, x) => s + x.gain, 0)))
  const next = items.sort((a, b) => b.gain - a.gain)[0] ?? null
  const bucket = score >= 85 ? 'strong' : score >= 65 ? 'good' : score >= 40 ? 'fair' : 'weak'
  return { score, next, bucket }
}

/**
 * The client's live strength meter. It runs rfqQualityPrecheck — the rules the
 * server runs at create (S1.5) — so there is one rule set and the two agree.
 */
export function rfqQualityScore(input: RfqQualityPrecheckInput): RfqQualityScore {
  return scoreFromPrecheck(rfqQualityPrecheck(input))
}

// ── FR-6.4 (N19 / F2) must-haves — shown to providers; NOT used in fan-out (D-PRD6) ──

export const RFQ_MUST_HAVE_LANGUAGES = ['en', 'hi', 'te', 'ta', 'mr', 'kn', 'bn', 'gu'] as const
export const rfqMustHavesSchema = z
  .object({
    credentials: z.array(z.enum(SEARCH_CREDENTIALS)).max(5).default([]),
    languages: z.array(z.enum(RFQ_MUST_HAVE_LANGUAGES)).max(5).default([]),
    onSite: z.boolean().default(false),
    inStateOnly: z.boolean().default(false),
  })
  .strict()
export type RfqMustHaves = z.infer<typeof rfqMustHavesSchema>
export const isEmptyMustHaves = (m: RfqMustHaves | null | undefined): boolean =>
  !m || (m.credentials.length === 0 && m.languages.length === 0 && !m.onSite && !m.inStateOnly)

// ── FR-6.3 documents the buyer expects to share ─────────────────────────────────

export const rfqDocumentsExpectedSchema = z.array(z.string().regex(/^[a-z0-9_]{1,40}$/)).max(12)

// ── Budget chips (bands write budget_min / budget_max, paise) ─────────────────────

export const RFQ_BUDGET_BANDS = {
  under2k: { max: 200_000 },
  '2kto5k': { min: 200_000, max: 500_000 },
  '5kto10k': { min: 500_000, max: 1_000_000 },
  '10kto25k': { min: 1_000_000, max: 2_500_000 },
  over25k: { min: 2_500_000 },
} as const satisfies Record<string, { min?: number; max?: number }>
export type RfqBudgetBand = keyof typeof RFQ_BUDGET_BANDS
export const RFQ_BUDGET_BAND_KEYS = Object.keys(RFQ_BUDGET_BANDS) as RfqBudgetBand[]

/** The band a stored min/max came from (a repost shows its chip), or null. */
export function budgetBandOf(minPaise: number | null | undefined, maxPaise: number | null | undefined): RfqBudgetBand | null {
  for (const k of RFQ_BUDGET_BAND_KEYS) {
    const b = RFQ_BUDGET_BANDS[k] as { min?: number; max?: number }
    if ((b.min ?? null) === (minPaise ?? null) && (b.max ?? null) === (maxPaise ?? null)) return k
  }
  return null
}

// ── FR-6.5 (N38) quote SLA line ─────────────────────────────────────────────────

export const QUOTE_SLA_MIN_N = 20
export const QUOTE_SLA_FALLBACK_HOURS = 72
/** "Quotes usually arrive within ~X h" when n ≥ 20, else the 72-hour promise. */
export function quoteSlaHours(stat: { medianMinutes: number | null; n: number } | null | undefined): { hours: number; measured: boolean } {
  if (!stat || stat.medianMinutes == null || stat.n < QUOTE_SLA_MIN_N) return { hours: QUOTE_SLA_FALLBACK_HOURS, measured: false }
  return { hours: Math.max(1, Math.ceil(stat.medianMinutes / 60)), measured: true }
}

// ── FR-6.6 (N20) prefill contract ───────────────────────────────────────────────

export const RFQ_ENTRY_POINTS = ['header', 'search', 'provider', 'package', 'home', 'buy_again', 'repost', 'direct'] as const
export type RfqEntryPoint = (typeof RFQ_ENTRY_POINTS)[number]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const rfqPrefillSchema = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.enum(CATEGORY_SLUGS).optional(),
  service: z.string().refine((s) => (ALL_SPECIALIZATIONS as readonly string[]).includes(s)).optional(),
  from_package: z.string().regex(UUID).optional(),
  from_provider: z.string().regex(/^[a-z0-9-]{1,80}$/).optional(),
  from: z.string().regex(UUID).optional(),
  entry: z.enum(RFQ_ENTRY_POINTS).optional(),
})
export type RfqPrefillInput = z.infer<typeof rfqPrefillSchema>

/** Lenient: each key is kept only if it is valid on its own. */
export function parseRfqPrefill(raw: Record<string, string | undefined>): RfqPrefillInput {
  const out: Record<string, string> = {}
  for (const k of Object.keys(rfqPrefillSchema.shape) as (keyof RfqPrefillInput)[]) {
    const v = raw[k]
    if (v === undefined || v === '') continue
    const one = rfqPrefillSchema.shape[k].safeParse(v)
    if (one.success && one.data !== undefined) out[k] = one.data as string
  }
  return out as RfqPrefillInput
}
