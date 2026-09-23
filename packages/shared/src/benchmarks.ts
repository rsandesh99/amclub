import { z } from 'zod'
import { formatRupees } from './munshi'
import { INDIAN_STATES } from './states'

/**
 * Fair price ranges (BUILD_PROMPTS S3.2, A3) — density-gated benchmarks from PAID services jobs.
 *
 * The laws (every one is code, never a model):
 *   1. "Closed" means paid: a services order with a captured payment that was not cancelled or refunded, priced at
 *      `orders.price_paise` (ex-GST). Submitted quotes are NEVER inputs — they are asks, and a provider could move the
 *      band just by quoting. Goods are excluded in v1.
 *   2. Privacy before usefulness: a range exists only when the sample, the distinct providers and the distinct buyers
 *      all pass their gates AND no single provider contributes more than the share cap. Percentiles are rounded.
 *      Nothing here carries a provider, buyer, order or quote id.
 *   3. Symmetric: the buyer and every matched provider see the same line for the same request.
 *   4. Not advice: the line is fixed copy with numbers. The optional explanatory sentence is policed for advice,
 *      ranking and any number that is not in the row (`benchmarkNoteViolations`).
 */

export const BENCHMARK_VERSION = 'v1'
export const BENCHMARK_WINDOW_DAYS = 180

export interface BenchmarkGates {
  /** jobs in the key (benchmark_min_sample) */
  minSample: number
  /** distinct providers (benchmark_min_providers) */
  minProviders: number
  /** distinct buyers (benchmark_min_buyers) */
  minBuyers: number
  /** the largest single provider's share of the sample, in basis points (benchmark_max_provider_share_bps) */
  maxProviderShareBps: number
}

export const BENCHMARK_DEFAULT_GATES: BenchmarkGates = { minSample: 30, minProviders: 8, minBuyers: 8, maxProviderShareBps: 2500 }

/** One eligible paid order (the `benchmark_inputs` SQL function's row, minus the key columns). */
export interface BenchmarkInputRow {
  price_paise: number
  provider_id: string
  msme_id: string
  /** first `deliver` event minus the payment (order creation), whole days rounded up; null = not delivered yet */
  delivery_days: number | null
}

export type BenchmarkGateReason = 'sample' | 'providers' | 'buyers' | 'provider_share'
export const BENCHMARK_GATE_REASONS: readonly BenchmarkGateReason[] = ['sample', 'providers', 'buyers', 'provider_share']

export interface BenchmarkStats {
  p25_paise: number
  p50_paise: number
  p75_paise: number
  /** null when the delivered subset does not pass the same gates on its own */
  median_delivery_days: number | null
  p25_delivery_days: number | null
  p75_delivery_days: number | null
  sample_n: number
  providers_n: number
  buyers_n: number
}

export type BenchmarkOutcome = BenchmarkStats | { gated: BenchmarkGateReason }

export const isGated = (o: BenchmarkOutcome): o is { gated: BenchmarkGateReason } => 'gated' in o

/** Nearest-rank percentile of an ascending, non-empty integer array (p in 1..100). */
export function nearestRank(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('nearestRank: empty')
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
  return sorted[rank - 1]!
}

const RUPEE = 100
/**
 * The rounding rule, on the unrounded value: to the nearest ₹100 below ₹10,000, ₹500 below ₹1,00,000, ₹1,000 above;
 * halves round up; never below one step (a range of "₹0" is never shown). Monotonic: every step boundary is a multiple
 * of both neighbouring steps, so a ≤ b ⇒ round(a) ≤ round(b).
 */
export function roundBenchmarkPaise(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 100 * RUPEE
  const step = v < 10_000 * RUPEE ? 100 * RUPEE : v < 100_000 * RUPEE ? 500 * RUPEE : 1_000 * RUPEE
  return Math.max(step, Math.floor(v / step + 0.5) * step)
}

/** Which gate a set of rows fails first (sample → providers → buyers → provider share), or null when it passes. */
export function benchmarkGate(rows: readonly BenchmarkInputRow[], gates: BenchmarkGates): BenchmarkGateReason | null {
  if (rows.length < gates.minSample) return 'sample'
  const byProvider = new Map<string, number>()
  for (const r of rows) byProvider.set(r.provider_id, (byProvider.get(r.provider_id) ?? 0) + 1)
  if (byProvider.size < gates.minProviders) return 'providers'
  if (new Set(rows.map((r) => r.msme_id)).size < gates.minBuyers) return 'buyers'
  const largest = Math.max(...byProvider.values())
  // integer arithmetic: largest / n > bps / 10 000  ⇔  largest × 10 000 > bps × n
  if (largest * 10_000 > gates.maxProviderShareBps * rows.length) return 'provider_share'
  return null
}

const validRow = (r: BenchmarkInputRow): boolean =>
  Number.isSafeInteger(r.price_paise) && r.price_paise > 0 && typeof r.provider_id === 'string' && r.provider_id.length > 0 && typeof r.msme_id === 'string' && r.msme_id.length > 0

/**
 * The v1 formula: gates first, then nearest-rank p25 / p50 / p75 on integer paise, rounded, forced monotonic. The
 * delivery range comes from the delivered subset only when that subset passes the same four gates by itself (so a
 * handful of delivered jobs can never be read off the "typically in" clause); otherwise it is null.
 */
export function computeBenchmark(input: readonly BenchmarkInputRow[], gates: BenchmarkGates = BENCHMARK_DEFAULT_GATES): BenchmarkOutcome {
  const rows = input.filter(validRow)
  const reason = benchmarkGate(rows, gates)
  if (reason) return { gated: reason }
  const prices = rows.map((r) => r.price_paise).sort((a, b) => a - b)
  const p25 = roundBenchmarkPaise(nearestRank(prices, 25))
  const p50 = Math.max(p25, roundBenchmarkPaise(nearestRank(prices, 50)))
  const p75 = Math.max(p50, roundBenchmarkPaise(nearestRank(prices, 75)))

  const delivered = rows.filter((r) => r.delivery_days != null && Number.isFinite(r.delivery_days) && (r.delivery_days as number) >= 0)
  let d25: number | null = null
  let d50: number | null = null
  let d75: number | null = null
  if (delivered.length > 0 && benchmarkGate(delivered, gates) === null) {
    const days = delivered.map((r) => Math.ceil(r.delivery_days as number)).sort((a, b) => a - b)
    d25 = nearestRank(days, 25)
    d50 = Math.max(d25, nearestRank(days, 50))
    d75 = Math.max(d50, nearestRank(days, 75))
  }
  return {
    p25_paise: p25,
    p50_paise: p50,
    p75_paise: p75,
    median_delivery_days: d50,
    p25_delivery_days: d25,
    p75_delivery_days: d75,
    sample_n: rows.length,
    providers_n: new Set(rows.map((r) => r.provider_id)).size,
    buyers_n: new Set(rows.map((r) => r.msme_id)).size,
  }
}

// ── the key + the view (aggregates only; never an id) ────────────────────────

export const BENCHMARK_SCOPES = ['state', 'national'] as const
export type BenchmarkScope = (typeof BENCHMARK_SCOPES)[number]

/** One `benchmark_inputs` row: the key parts + the order's facts (ids stay inside the compute, never in a row). */
export interface BenchmarkSourceRow extends BenchmarkInputRow {
  category_slug: string
  state: string | null
}

export interface BenchmarkKey {
  category_slug: string
  scope: BenchmarkScope
  state: string | null
}

export const benchmarkKeyId = (k: BenchmarkKey): string => `${k.category_slug}|${k.scope}|${k.state ?? ''}`

/** Group source rows into the v1 keys: (category, state) for rows with a state, and (category, national) for all. */
export function groupBenchmarkKeys(rows: readonly BenchmarkSourceRow[]): Map<string, { key: BenchmarkKey; rows: BenchmarkInputRow[] }> {
  const out = new Map<string, { key: BenchmarkKey; rows: BenchmarkInputRow[] }>()
  const add = (key: BenchmarkKey, r: BenchmarkSourceRow) => {
    const id = benchmarkKeyId(key)
    const hit = out.get(id) ?? { key, rows: [] }
    hit.rows.push({ price_paise: r.price_paise, provider_id: r.provider_id, msme_id: r.msme_id, delivery_days: r.delivery_days })
    out.set(id, hit)
  }
  for (const r of rows) {
    if (!r.category_slug) continue
    if (r.state) add({ category_slug: r.category_slug, scope: 'state', state: r.state }, r)
    add({ category_slug: r.category_slug, scope: 'national', state: null }, r)
  }
  return out
}

/**
 * What a page, the API and mobile receive. Strict: the numbers, the scope and state, the sample sizes and when it was
 * computed — no provider, buyer, order or quote id, and no buyer count (it adds nothing a reader needs).
 */
export const benchmarkViewSchema = z
  .object({
    category_slug: z.string().min(1).max(64),
    scope: z.enum(BENCHMARK_SCOPES),
    state: z.string().length(2).nullable(),
    p25_paise: z.number().int().positive(),
    p50_paise: z.number().int().positive(),
    p75_paise: z.number().int().positive(),
    median_delivery_days: z.number().int().min(0).nullable(),
    p25_delivery_days: z.number().int().min(0).nullable(),
    p75_delivery_days: z.number().int().min(0).nullable(),
    sample_n: z.number().int().positive(),
    providers_n: z.number().int().positive(),
    computed_at: z.string().min(1),
    /** the optional explanatory sentence in the viewer's locale (benchmark_explain@v1), or null */
    note: z.string().max(400).nullable(),
  })
  .strict()
export type BenchmarkView = z.infer<typeof benchmarkViewSchema>

// ── the line (fixed copy with numbers; en / hi / te / ta) ────────────────────

export const BENCHMARK_LOCALES = ['en', 'hi', 'te', 'ta'] as const
export type BenchmarkLocale = (typeof BENCHMARK_LOCALES)[number]
export const toBenchmarkLocale = (l: string | null | undefined): BenchmarkLocale => (BENCHMARK_LOCALES as readonly string[]).includes(l ?? '') ? (l as BenchmarkLocale) : 'en'

export const stateName = (code: string | null): string | null => (code ? (INDIAN_STATES.find((s) => s.value === code)?.label ?? null) : null)

interface LineParts { place: string | null; low: string; high: string; days: string | null; n: number; providers: number }

const LINE: Record<BenchmarkLocale, { line: (p: LineParts) => string; days: (a: number, b: number) => string }> = {
  en: {
    line: (p) => `Similar jobs ${p.place ? `in ${p.place}` : 'across India'} closed at ${p.low}–${p.high}${p.days ? `, ${p.days}` : ''} (based on ${p.n} paid jobs from ${p.providers} providers).`,
    days: (a, b) => (a === b ? `typically in ${a} ${a === 1 ? 'day' : 'days'}` : `typically in ${a}–${b} days`),
  },
  hi: {
    line: (p) => `${p.place ? `${p.place} में` : 'पूरे भारत में'} मिलते-जुलते काम ${p.low}–${p.high} में हुए${p.days ? `, ${p.days}` : ''} (${p.providers} प्रोवाइडरों के ${p.n} भुगतान हुए कामों के आधार पर)।`,
    days: (a, b) => (a === b ? `आम तौर पर ${a} दिन में` : `आम तौर पर ${a}–${b} दिन में`),
  },
  te: {
    line: (p) => `${p.place ? `${p.place}లో` : 'భారతదేశం అంతటా'} ఇలాంటి పనులు ${p.low}–${p.high}కి జరిగాయి${p.days ? `, ${p.days}` : ''} (${p.providers} ప్రొవైడర్ల ${p.n} చెల్లించిన పనుల ఆధారంగా).`,
    days: (a, b) => (a === b ? `సాధారణంగా ${a} రోజుల్లో` : `సాధారణంగా ${a}–${b} రోజుల్లో`),
  },
  ta: {
    line: (p) => `${p.place ? `${p.place} இல்` : 'இந்தியா முழுவதும்'} இதே போன்ற வேலைகள் ${p.low}–${p.high} க்கு நடந்தன${p.days ? `, ${p.days}` : ''} (${p.providers} வழங்குநர்களின் ${p.n} பணம் செலுத்தப்பட்ட வேலைகளின் அடிப்படையில்).`,
    days: (a, b) => (a === b ? `பொதுவாக ${a} நாட்களில்` : `பொதுவாக ${a}–${b} நாட்களில்`),
  },
}

type LineInput = Pick<BenchmarkView, 'scope' | 'state' | 'p25_paise' | 'p75_paise' | 'p25_delivery_days' | 'p75_delivery_days' | 'sample_n' | 'providers_n'>

/** The ONE line both sides see: p25–p75, the delivery range when present, the sample. Fixed copy; money via formatRupees. */
export function benchmarkLine(v: LineInput, locale: string): string {
  const L = LINE[toBenchmarkLocale(locale)]
  const place = v.scope === 'state' ? stateName(v.state) : null
  const days = v.p25_delivery_days != null && v.p75_delivery_days != null ? L.days(v.p25_delivery_days, v.p75_delivery_days) : null
  return L.line({ place, low: formatRupees(v.p25_paise), high: formatRupees(v.p75_paise), days, n: v.sample_n, providers: v.providers_n })
}

// ── the optional note's output policy (benchmark_explain@v1) ─────────────────

/**
 * Advice / judgement words the explanatory sentence may never use, in every locale (on top of customerFacingText's
 * ranking / approval / payment / contact / url checks). Matched on the NFKC-lowercased sentence as whole words.
 */
export const BENCHMARK_NOTE_BANNED: Record<BenchmarkLocale, readonly string[]> = {
  en: ['should', 'must', 'ought', 'fair price', 'fair rate', 'overpriced', 'underpriced', 'overcharg', 'cheap', 'cheaper', 'cheapest', 'expensive', 'too high', 'too low', 'good deal', 'great deal', 'best price', 'good price', 'bargain', 'negotiat', 'haggle', 'recommend', 'advise', 'rip-off', 'ripoff'],
  hi: ['चाहिए', 'उचित कीमत', 'सही कीमत', 'सस्ता', 'सस्ती', 'सस्ते', 'महंगा', 'महँगा', 'महंगी', 'महँगी', 'मोलभाव', 'मोल-भाव', 'सौदेबाज़ी', 'सौदेबाजी', 'ज़्यादा कीमत', 'ज्यादा कीमत', 'बहुत कम', 'सलाह'],
  te: ['తప్పక', 'తప్పనిసరిగా', 'సరైన ధర', 'న్యాయమైన ధర', 'చౌక', 'చవక', 'ఖరీదైన', 'ఖరీదు ఎక్కువ', 'బేరం', 'బేరమాడ', 'సలహా'],
  ta: ['வேண்டும்', 'நியாயமான விலை', 'சரியான விலை', 'மலிவு', 'மலிவான', 'விலை அதிகம்', 'அதிக விலை', 'பேரம்', 'பரிந்துரை', 'அறிவுரை'],
}

const INDIC_DIGITS: Record<string, string> = {}
for (const [base, name] of [[0x0966, 'deva'], [0x0c66, 'telu'], [0x0be6, 'taml']] as const) {
  void name
  for (let d = 0; d <= 9; d++) INDIC_DIGITS[String.fromCharCode(base + d)] = String(d)
}
const foldDigits = (s: string): string => s.replace(/[०-९౦-౯௦-௯]/g, (c) => INDIC_DIGITS[c] ?? c)

/** Every number written in a sentence, Indian grouping and decimals folded ("₹18,000" → 18000; "2.5" → 2.5). */
export function numbersIn(text: string): number[] {
  const out: number[] = []
  for (const m of foldDigits(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''))
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

/** The numbers a note may use: the row's rupee values, day values and sample sizes — nothing else. */
export function allowedNoteNumbers(v: Pick<BenchmarkView, 'p25_paise' | 'p50_paise' | 'p75_paise' | 'median_delivery_days' | 'p25_delivery_days' | 'p75_delivery_days' | 'sample_n' | 'providers_n'>): Set<number> {
  const s = new Set<number>()
  for (const p of [v.p25_paise, v.p50_paise, v.p75_paise]) s.add(p / 100)
  for (const d of [v.median_delivery_days, v.p25_delivery_days, v.p75_delivery_days]) if (d != null) s.add(d)
  s.add(v.sample_n)
  s.add(v.providers_n)
  return s
}

export type BenchmarkNoteViolation = 'number_not_in_row' | 'banned_word' | 'empty' | 'too_long'

/** The note's own policy: every number must be one of the row's, and no advice / judgement word in any locale. */
export function benchmarkNoteViolations(note: string, v: Parameters<typeof allowedNoteNumbers>[0]): BenchmarkNoteViolation[] {
  const out: BenchmarkNoteViolation[] = []
  const t = note.normalize('NFKC').toLowerCase().trim()
  if (!t) return ['empty']
  if (t.length > 400) out.push('too_long')
  const allowed = allowedNoteNumbers(v)
  if (numbersIn(t).some((n) => !allowed.has(n))) out.push('number_not_in_row')
  const words = Object.values(BENCHMARK_NOTE_BANNED).flat()
  if (words.some((w) => bannedHit(t, w))) out.push('banned_word')
  return out
}

function bannedHit(text: string, word: string): boolean {
  const w = word.normalize('NFKC').toLowerCase()
  // Latin stems ("negotiat", "overcharg") match as a word prefix; everything else as a whole word / phrase
  if (/^[a-z -]+$/.test(w)) return new RegExp(`(^|[^a-z])${w}`).test(text)
  return text.includes(w)
}

// ── the note's contract + the keyless stub ───────────────────────────────────

export const BENCHMARK_NOTE_MAX = 280

/** `benchmark_explain@v1` output (bare; agent-core wraps it with customerFacingText). */
export const benchmarkExplainSchema = z.object({ note: z.string().trim().min(1).max(BENCHMARK_NOTE_MAX) }).strict()
export type BenchmarkExplain = z.infer<typeof benchmarkExplainSchema>

type NoteInput = Pick<BenchmarkView, 'p25_paise' | 'p50_paise' | 'p75_paise' | 'sample_n'>

const STUB_NOTE: Record<BenchmarkLocale, (low: string, mid: string, high: string, n: number) => string> = {
  en: (low, mid, high, n) => `Of the ${n} similar paid jobs, the middle half were priced between ${low} and ${high}, and the typical job was around ${mid}.`,
  hi: (low, mid, high, n) => `${n} मिलते-जुलते भुगतान हुए कामों में से बीच के आधे काम ${low} से ${high} के बीच रहे, और आम काम लगभग ${mid} का था।`,
  te: (low, mid, high, n) => `${n} ఇలాంటి చెల్లించిన పనుల్లో మధ్యలోని సగం పనులు ${low} నుండి ${high} మధ్య ఉన్నాయి, సాధారణ పని దాదాపు ${mid}.`,
  ta: (low, mid, high, n) => `${n} இதே போன்ற பணம் செலுத்தப்பட்ட வேலைகளில் நடுவில் உள்ள பாதி ${low} முதல் ${high} வரை இருந்தன, வழக்கமான வேலை சுமார் ${mid}.`,
}

/** The keyless note: what the range means, in the viewer's locale, from the row's own numbers only (no advice). */
export function stubBenchmarkNote(v: NoteInput, locale: string): BenchmarkExplain {
  const text = STUB_NOTE[toBenchmarkLocale(locale)](formatRupees(v.p25_paise), formatRupees(v.p50_paise), formatRupees(v.p75_paise), v.sample_n)
  return { note: text.length > BENCHMARK_NOTE_MAX ? text.slice(0, BENCHMARK_NOTE_MAX - 1).trimEnd() + '…' : text }
}
