/**
 * S2.4 — AMC Score v1 (ADR-010). The formula is code, versioned; thresholds and
 * exposure switches are settings. Pure: no I/O, no model, no reviews, no text.
 *
 *   inputs (windowed SQL counts, score_inputs_provider / score_inputs_buyer)
 *     → components 0..100 (null when the component has no sample)
 *     → score = Σ weight × value ÷ Σ weight over the NON-null components,
 *       rounded half-up ONCE; null below the sample gate.
 *
 * Any change to inputs, curves, weights or gates is a new SCORE_VERSION (a
 * parallel compute and a founder switch) — never a silent shift.
 */
import { z } from 'zod'

export const SCORE_VERSION = 'v1' as const
export type ScoreVersion = typeof SCORE_VERSION
export const SCORE_WINDOW_DAYS = 90

export const PROVIDER_COMPONENTS = ['responsiveness', 'on_time', 'buyer_confirmation', 'dispute_record', 'decision_rate'] as const
export type ProviderComponent = (typeof PROVIDER_COMPONENTS)[number]
export const BUYER_COMPONENTS = ['confirmation_speed', 'follow_through', 'dispute_record', 'payment_follow_through'] as const
export type BuyerComponent = (typeof BUYER_COMPONENTS)[number]
export type ScoreComponent = ProviderComponent | BuyerComponent

/** Sum 100 each (tested). ADR-010 §3. */
export const PROVIDER_WEIGHTS_V1: Readonly<Record<ProviderComponent, number>> = { responsiveness: 25, on_time: 25, buyer_confirmation: 20, dispute_record: 20, decision_rate: 10 }
export const BUYER_WEIGHTS_V1: Readonly<Record<BuyerComponent, number>> = { confirmation_speed: 30, follow_through: 30, dispute_record: 20, payment_follow_through: 20 }

/** Below these the whole score is null (the components are still computed and stored). ADR-010 §3. */
export const SAMPLE_GATES_V1 = {
  provider: { closed_orders: 3, response_samples: 3 },
  buyer: { rfqs_with_quotes: 2, closed_orders: 1 },
} as const

// ── inputs (one row per subject from the SQL functions; counts in the 90-day window) ──

export interface ProviderScoreInputs {
  /** quotes whose match notification → quote time is measurable */
  response_samples: number
  median_response_hours: number | null
  /** orders whose FIRST deliver event is in the window */
  delivered_orders: number
  /** …of which that first deliver was ≤ due_at (no due_at counts as on time) */
  on_time_deliveries: number
  /** completed / reviewed orders completed in the window */
  completed_orders: number
  confirmed_by_buyer: number
  auto_accepted: number
  /** completed / reviewed + resolved_* orders closed in the window (the dispute denominator + the gate) */
  closed_orders: number
  /** disputes resolved refund_full / refund_partial in the window */
  disputes_at_fault: number
  /** matches notified in the window that were quoted, declined (any reason) or whose request is no longer open */
  matches_decided_or_closed: number
  matches_quoted: number
  /** declined with a reason (a window_lapsed auto-decline is NOT a decision) */
  matches_declined_with_reason: number
}

export interface BuyerScoreInputs {
  /** completed orders with a first deliver event; an auto-accepted one counts as 72 h */
  confirmation_samples: number
  median_confirmation_hours: number | null
  /** closed RFQs (accepted / expired / cancelled) that received ≥ 1 quote */
  rfqs_with_quotes: number
  /** …that ended accepted, or where the buyer explicitly declined quotes */
  rfqs_followed_through: number
  closed_orders: number
  /** disputes the buyer raised that were resolved `release` */
  disputes_unfounded: number
  /** checkout subjects (a package / a quote) paid, or whose sessions all expired unpaid */
  checkout_subjects_decided: number
  checkout_subjects_paid: number
}

export interface ComponentResult {
  /** 0..100, rounded for display (the score uses the exact value); null = no sample */
  value: number | null
  sample: number
  raw: Record<string, number | null>
  /** the nominal weight (redistribution happens in the score, not here) */
  weight: number
}

export interface ScoreResult<C extends string> {
  version: ScoreVersion
  score: number | null
  gated: boolean
  components: Record<C, ComponentResult>
  sample: Record<string, number>
}

// ── curves (ADR-010 §3; code is the truth) ──────────────────────────────────

/** Piecewise-linear through ascending knots [x, y]; clamped outside. */
export function piecewise(x: number, knots: readonly (readonly [number, number])[]): number {
  if (!knots.length) throw new Error('piecewise: no knots')
  const first = knots[0]!
  const last = knots[knots.length - 1]!
  if (x <= first[0]) return first[1]
  if (x >= last[0]) return last[1]
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i]!
    const [x0, y0] = knots[i - 1]!
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
  }
  return last[1]
}

export const RESPONSIVENESS_KNOTS = [[2, 100], [24, 50], [72, 0]] as const
export const CONFIRMATION_SPEED_KNOTS = [[24, 100], [72, 0]] as const
/** One fault in four closed orders = 0. */
export const DISPUTE_FAULT_MULTIPLIER = 400

const ratio = (num: number, den: number): number | null => (den > 0 ? Math.min(100, Math.max(0, (num / den) * 100)) : null)
const disputeCurve = (faults: number, closed: number): number | null => (closed > 0 ? 100 - Math.min(100, (faults / closed) * DISPUTE_FAULT_MULTIPLIER) : null)
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const hours = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

/** Round half-up once (the epsilon keeps an exact .5 from flooring on float noise). */
export function roundScore(x: number): number {
  return Math.min(100, Math.max(0, Math.floor(x + 0.5 + 1e-9)))
}

function component(value: number | null, sample: number, raw: Record<string, number | null>, weight: number): { exact: number | null; result: ComponentResult } {
  const exact = sample > 0 && value !== null ? value : null
  return { exact, result: { value: exact === null ? null : roundScore(exact), sample, raw, weight } }
}

/** Σ w·v ÷ Σ w over the non-null components (a null component's weight redistributes proportionally). */
export function weightedScore(parts: readonly { exact: number | null; weight: number }[]): number | null {
  let num = 0
  let den = 0
  for (const p of parts) {
    if (p.exact === null || p.weight <= 0) continue
    num += p.exact * p.weight
    den += p.weight
  }
  return den > 0 ? roundScore(num / den) : null
}

export function scoreProvider(inputs: ProviderScoreInputs, weights: Readonly<Record<ProviderComponent, number>> = PROVIDER_WEIGHTS_V1): ScoreResult<ProviderComponent> {
  const rs = n(inputs.response_samples)
  const med = hours(inputs.median_response_hours)
  const parts: Record<ProviderComponent, { exact: number | null; result: ComponentResult }> = {
    responsiveness: component(med === null ? null : piecewise(med, RESPONSIVENESS_KNOTS), med === null ? 0 : rs, { median_response_hours: med, response_samples: rs }, weights.responsiveness),
    on_time: component(ratio(n(inputs.on_time_deliveries), n(inputs.delivered_orders)), n(inputs.delivered_orders), { on_time_deliveries: n(inputs.on_time_deliveries), delivered_orders: n(inputs.delivered_orders) }, weights.on_time),
    buyer_confirmation: component(ratio(n(inputs.confirmed_by_buyer) + 0.5 * n(inputs.auto_accepted), n(inputs.completed_orders)), n(inputs.completed_orders), { confirmed_by_buyer: n(inputs.confirmed_by_buyer), auto_accepted: n(inputs.auto_accepted), completed_orders: n(inputs.completed_orders) }, weights.buyer_confirmation),
    dispute_record: component(disputeCurve(n(inputs.disputes_at_fault), n(inputs.closed_orders)), n(inputs.closed_orders), { disputes_at_fault: n(inputs.disputes_at_fault), closed_orders: n(inputs.closed_orders) }, weights.dispute_record),
    decision_rate: component(ratio(n(inputs.matches_quoted) + n(inputs.matches_declined_with_reason), n(inputs.matches_decided_or_closed)), n(inputs.matches_decided_or_closed), { matches_quoted: n(inputs.matches_quoted), matches_declined_with_reason: n(inputs.matches_declined_with_reason), matches_decided_or_closed: n(inputs.matches_decided_or_closed) }, weights.decision_rate),
  }
  const gate = SAMPLE_GATES_V1.provider
  const sample = { closed_orders: n(inputs.closed_orders), response_samples: rs }
  const gated = sample.closed_orders < gate.closed_orders || sample.response_samples < gate.response_samples
  const components = Object.fromEntries(PROVIDER_COMPONENTS.map((k) => [k, parts[k].result])) as Record<ProviderComponent, ComponentResult>
  return { version: SCORE_VERSION, score: gated ? null : weightedScore(PROVIDER_COMPONENTS.map((k) => ({ exact: parts[k].exact, weight: weights[k] }))), gated, components, sample }
}

export function scoreBuyer(inputs: BuyerScoreInputs, weights: Readonly<Record<BuyerComponent, number>> = BUYER_WEIGHTS_V1): ScoreResult<BuyerComponent> {
  const cs = n(inputs.confirmation_samples)
  const med = hours(inputs.median_confirmation_hours)
  const parts: Record<BuyerComponent, { exact: number | null; result: ComponentResult }> = {
    confirmation_speed: component(med === null ? null : piecewise(med, CONFIRMATION_SPEED_KNOTS), med === null ? 0 : cs, { median_confirmation_hours: med, confirmation_samples: cs }, weights.confirmation_speed),
    follow_through: component(ratio(n(inputs.rfqs_followed_through), n(inputs.rfqs_with_quotes)), n(inputs.rfqs_with_quotes), { rfqs_followed_through: n(inputs.rfqs_followed_through), rfqs_with_quotes: n(inputs.rfqs_with_quotes) }, weights.follow_through),
    dispute_record: component(disputeCurve(n(inputs.disputes_unfounded), n(inputs.closed_orders)), n(inputs.closed_orders), { disputes_unfounded: n(inputs.disputes_unfounded), closed_orders: n(inputs.closed_orders) }, weights.dispute_record),
    payment_follow_through: component(ratio(n(inputs.checkout_subjects_paid), n(inputs.checkout_subjects_decided)), n(inputs.checkout_subjects_decided), { checkout_subjects_paid: n(inputs.checkout_subjects_paid), checkout_subjects_decided: n(inputs.checkout_subjects_decided) }, weights.payment_follow_through),
  }
  const gate = SAMPLE_GATES_V1.buyer
  const sample = { rfqs_with_quotes: n(inputs.rfqs_with_quotes), closed_orders: n(inputs.closed_orders) }
  const gated = sample.rfqs_with_quotes < gate.rfqs_with_quotes || sample.closed_orders < gate.closed_orders
  const components = Object.fromEntries(BUYER_COMPONENTS.map((k) => [k, parts[k].result])) as Record<BuyerComponent, ComponentResult>
  return { version: SCORE_VERSION, score: gated ? null : weightedScore(BUYER_COMPONENTS.map((k) => ({ exact: parts[k].exact, weight: weights[k] }))), gated, components, sample }
}

/** The n weakest scored components (lowest value first; ties → the heavier weight first, then list order). For tips. */
export function weakestComponents<C extends string>(components: Record<C, ComponentResult>, order: readonly C[], n = 2): C[] {
  return order
    .map((k, i) => ({ k, i, c: components[k] }))
    .filter((x) => x.c && x.c.value !== null)
    .sort((a, b) => a.c.value! - b.c.value! || b.c.weight - a.c.weight || a.i - b.i)
    .slice(0, n)
    .map((x) => x.k)
}

/** The component whose value moved most between two snapshots (the score_events reason). */
export function biggestMover<C extends string>(before: Partial<Record<C, ComponentResult>> | null, after: Record<C, ComponentResult>, order: readonly C[]): C | null {
  let best: C | null = null
  let bestDelta = 0
  for (const k of order) {
    const a = before?.[k]?.value ?? null
    const b = after[k]?.value ?? null
    const d = a === null && b === null ? 0 : Math.abs((b ?? 0) - (a ?? 0))
    if (d > bestDelta) { best = k; bestDelta = d }
  }
  return best
}

// ── reliability-adjusted ordering (ADR-010 §7) ───────────────────────────────

export interface ReliabilityOpts {
  /** score_null_prior: what a null (gated / unknown) score ranks as */
  nullPrior: number
  /** reliability_rank_k_bps */
  kBps: number
}

/**
 * Integer paise: total × (1 000 000 + k × (100 − s)) ÷ 1 000 000, rounded half-up once (BigInt — exact).
 * `k` is the penalty in basis points at score 0, scaling linearly with the shortfall from 100: with k = 1500 a score
 * of 90 adds 1.5 %, the neutral 60 adds 6 %, 40 adds 9 %, 0 adds 15 %. (The prompt's `(10000 + k × (100 − s)) ÷ 10000`
 * would add 150 % at a score of 90 with the default k — ADR-010 §7, FOLLOWUPS S2.4.)
 */
export function reliabilityAdjustedTotal(normalizedTotalPaise: number, score: number | null, opts: ReliabilityOpts): number {
  const s = Math.min(100, Math.max(0, Math.round(score ?? opts.nullPrior)))
  const k = Math.min(10_000, Math.max(0, Math.round(opts.kBps)))
  const total = BigInt(Math.round(normalizedTotalPaise))
  const factor = BigInt(1_000_000 + k * (100 - s))
  // BigInt(…) rather than literals: the web app targets below ES2020
  return Number((total * factor + BigInt(500_000)) / BigInt(1_000_000))
}

export interface OrderableQuote {
  id: string
  normalizedTotalPaise: number
  providerScore: number | null
}

/** Stable: adjusted total asc → normalised total asc → id asc. */
export function reliabilityOrder(quotes: readonly OrderableQuote[], opts: ReliabilityOpts): string[] {
  return quotes
    .map((q) => ({ q, adj: reliabilityAdjustedTotal(q.normalizedTotalPaise, q.providerScore, opts) }))
    .sort((a, b) => a.adj - b.adj || a.q.normalizedTotalPaise - b.q.normalizedTotalPaise || (a.q.id < b.q.id ? -1 : a.q.id > b.q.id ? 1 : 0))
    .map((x) => x.q.id)
}

/** Price order exactly as the screen's own price sort does (normalised total asc; ties keep the input order). */
export function priceOrder(quotes: readonly Pick<OrderableQuote, 'id' | 'normalizedTotalPaise'>[]): string[] {
  return quotes.map((q, i) => ({ q, i })).sort((a, b) => a.q.normalizedTotalPaise - b.q.normalizedTotalPaise || a.i - b.i).map((x) => x.q.id)
}

export interface CompareOrdering {
  mode: 'price' | 'reliability'
  ids: string[]
}

/**
 * The compare screen's order. Reliability only when switched on, ≥ 2 quotes and the largest normalised total
 * reaches the threshold; otherwise the price order (the screen's default, byte-identical). Never carries a score.
 */
export function compareOrdering(quotes: readonly OrderableQuote[], opts: ReliabilityOpts & { enabled: boolean; thresholdPaise: number }): CompareOrdering {
  const max = quotes.reduce((m, q) => Math.max(m, q.normalizedTotalPaise), 0)
  if (!opts.enabled || quotes.length < 2 || max < opts.thresholdPaise) return { mode: 'price', ids: priceOrder(quotes) }
  return { mode: 'reliability', ids: reliabilityOrder(quotes, opts) }
}

// ── the snapshot contract (provider_scores / buyer_scores rows) ──────────────

const componentResultSchema = z
  .object({ value: z.number().int().min(0).max(100).nullable(), sample: z.number().int().min(0), raw: z.record(z.number().nullable()), weight: z.number().int().min(0).max(100) })
  .strict()

export const scoreSnapshotSchema = z
  .object({
    version: z.literal(SCORE_VERSION),
    score: z.number().int().min(0).max(100).nullable(),
    gated: z.boolean(),
    components: z.record(componentResultSchema),
    sample: z.record(z.number().int().min(0)),
    computed_at: z.string().datetime({ offset: true }),
  })
  .strict()
export type ScoreSnapshot = z.infer<typeof scoreSnapshotSchema>

/** Field names no buyer-reachable payload may carry (the privacy guard; ADR-010 §6). */
export const SCORE_FIELD_NAMES = ['score', 'score_version', 'components', 'provider_score', 'buyer_score', 'providerScore', 'buyerScore', 'amc_score', 'amcScore', 'reliability_score', 'reliabilityScore'] as const

/** Every path in `json` whose key is a score field (deep). Empty = clean. */
export function scoreFieldPaths(json: unknown, path = '$'): string[] {
  const out: string[] = []
  if (Array.isArray(json)) json.forEach((v, i) => out.push(...scoreFieldPaths(v, `${path}[${i}]`)))
  else if (json && typeof json === 'object') {
    for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
      if ((SCORE_FIELD_NAMES as readonly string[]).includes(k)) out.push(`${path}.${k}`)
      out.push(...scoreFieldPaths(v, `${path}.${k}`))
    }
  }
  return out
}
