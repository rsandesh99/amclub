import { describe, expect, it } from 'vitest'
import {
  BUYER_COMPONENTS,
  BUYER_WEIGHTS_V1,
  CONFIRMATION_SPEED_KNOTS,
  PROVIDER_COMPONENTS,
  PROVIDER_WEIGHTS_V1,
  RESPONSIVENESS_KNOTS,
  SAMPLE_GATES_V1,
  SCORE_VERSION,
  biggestMover,
  compareOrdering,
  piecewise,
  priceOrder,
  reliabilityAdjustedTotal,
  reliabilityOrder,
  roundScore,
  scoreBuyer,
  scoreFieldPaths,
  scoreProvider,
  scoreSnapshotSchema,
  weakestComponents,
  weightedScore,
  type BuyerScoreInputs,
  type ProviderScoreInputs,
} from '../score'
import { SCORE_TIPS, SCORE_TIP_LOCALES, scoreTip } from '../score-tips'
import { AGENT_SETTING_DEFS, TASK_CLASS_TIER, toolsForPersona } from '../index'

const P = (over: Partial<ProviderScoreInputs> = {}): ProviderScoreInputs => ({
  response_samples: 5, median_response_hours: 2,
  delivered_orders: 5, on_time_deliveries: 5,
  completed_orders: 5, confirmed_by_buyer: 5, auto_accepted: 0,
  closed_orders: 5, disputes_at_fault: 0,
  matches_decided_or_closed: 10, matches_quoted: 10, matches_declined_with_reason: 0,
  ...over,
})
const B = (over: Partial<BuyerScoreInputs> = {}): BuyerScoreInputs => ({
  confirmation_samples: 3, median_confirmation_hours: 12,
  rfqs_with_quotes: 4, rfqs_followed_through: 4,
  closed_orders: 3, disputes_unfounded: 0,
  checkout_subjects_decided: 3, checkout_subjects_paid: 3,
  ...over,
})
const OPTS = { nullPrior: 60, kBps: 1500 }

describe('weights, gates, version', () => {
  it('provider weights sum 100 and cover every component', () => {
    expect(Object.values(PROVIDER_WEIGHTS_V1).reduce((a, b) => a + b, 0)).toBe(100)
    expect(Object.keys(PROVIDER_WEIGHTS_V1).sort()).toEqual([...PROVIDER_COMPONENTS].sort())
  })
  it('buyer weights sum 100 and cover every component', () => {
    expect(Object.values(BUYER_WEIGHTS_V1).reduce((a, b) => a + b, 0)).toBe(100)
    expect(Object.keys(BUYER_WEIGHTS_V1).sort()).toEqual([...BUYER_COMPONENTS].sort())
  })
  it('the ADR-010 weights exactly', () => {
    expect(PROVIDER_WEIGHTS_V1).toEqual({ responsiveness: 25, on_time: 25, buyer_confirmation: 20, dispute_record: 20, decision_rate: 10 })
    expect(BUYER_WEIGHTS_V1).toEqual({ confirmation_speed: 30, follow_through: 30, dispute_record: 20, payment_follow_through: 20 })
  })
  it('gates and version', () => {
    expect(SAMPLE_GATES_V1).toEqual({ provider: { closed_orders: 3, response_samples: 3 }, buyer: { rfqs_with_quotes: 2, closed_orders: 1 } })
    expect(SCORE_VERSION).toBe('v1')
  })
})

describe('curves at their knots', () => {
  it.each([
    [0, 100], [2, 100], [13, 75], [24, 50], [48, 25], [72, 0], [200, 0],
  ])('responsiveness at %s h → %s', (h, v) => expect(piecewise(h, RESPONSIVENESS_KNOTS)).toBeCloseTo(v, 9))
  it.each([
    [0, 100], [24, 100], [48, 50], [60, 25], [72, 0], [96, 0],
  ])('confirmation speed at %s h → %s', (h, v) => expect(piecewise(h, CONFIRMATION_SPEED_KNOTS)).toBeCloseTo(v, 9))
  it('on_time = on-time ÷ delivered', () => {
    expect(scoreProvider(P({ on_time_deliveries: 3, delivered_orders: 4 })).components.on_time.value).toBe(75)
  })
  it('buyer_confirmation counts an auto-accept as half', () => {
    expect(scoreProvider(P({ completed_orders: 4, confirmed_by_buyer: 2, auto_accepted: 2 })).components.buyer_confirmation.value).toBe(75)
  })
  it.each([
    [0, 8, 100], [1, 8, 50], [1, 4, 0], [2, 4, 0], [1, 10, 60],
  ])('dispute record: %s at fault of %s closed → %s', (f, c, v) => {
    expect(scoreProvider(P({ disputes_at_fault: f, closed_orders: c })).components.dispute_record.value).toBe(v)
  })
  it('decision rate: a window-lapsed match is not decided', () => {
    expect(scoreProvider(P({ matches_decided_or_closed: 10, matches_quoted: 6, matches_declined_with_reason: 2 })).components.decision_rate.value).toBe(80)
  })
  it('buyer follow-through, dispute record and payment follow-through', () => {
    const r = scoreBuyer(B({ rfqs_with_quotes: 4, rfqs_followed_through: 3, closed_orders: 4, disputes_unfounded: 1, checkout_subjects_decided: 5, checkout_subjects_paid: 4 }))
    expect(r.components.follow_through.value).toBe(75)
    expect(r.components.dispute_record.value).toBe(0)
    expect(r.components.payment_follow_through.value).toBe(80)
  })
  it('an auto-accept-only buyer (median 72 h) scores 0 on confirmation speed', () => {
    expect(scoreBuyer(B({ median_confirmation_hours: 72 })).components.confirmation_speed.value).toBe(0)
  })
})

describe('the score', () => {
  it('a perfect provider scores 100; the components carry raw counts and nominal weights', () => {
    const r = scoreProvider(P())
    expect(r.score).toBe(100)
    expect(r.gated).toBe(false)
    expect(r.components.on_time).toEqual({ value: 100, sample: 5, raw: { on_time_deliveries: 5, delivered_orders: 5 }, weight: 25 })
  })
  it('a worked mixed provider: 25×50 + 25×80 + 20×75 + 20×50 + 10×90 = 66.5 → 67 (half-up once)', () => {
    const r = scoreProvider(P({ median_response_hours: 24, delivered_orders: 5, on_time_deliveries: 4, completed_orders: 4, confirmed_by_buyer: 2, auto_accepted: 2, closed_orders: 8, disputes_at_fault: 1, matches_decided_or_closed: 10, matches_quoted: 8, matches_declined_with_reason: 1 }))
    expect(r.score).toBe(67)
  })
  it('a null component redistributes its weight proportionally', () => {
    // decision_rate has no sample → the other four (weights 90) decide alone
    const r = scoreProvider(P({ matches_decided_or_closed: 0, matches_quoted: 0, on_time_deliveries: 0 }))
    expect(r.components.decision_rate.value).toBeNull()
    expect(r.score).toBe(roundScore((25 * 100 + 25 * 0 + 20 * 100 + 20 * 100) / 90))
  })
  it('a missing median response is a null component, not zero', () => {
    const r = scoreProvider(P({ median_response_hours: null }))
    expect(r.components.responsiveness.value).toBeNull()
    expect(r.components.responsiveness.sample).toBe(0)
  })
  it.each([
    [{ closed_orders: 2 }, true],
    [{ response_samples: 2 }, true],
    [{ closed_orders: 3, response_samples: 3 }, false],
  ])('provider gate %j → gated %s (and the score is null when gated)', (over, gated) => {
    const r = scoreProvider(P(over))
    expect(r.gated).toBe(gated)
    expect(r.score === null).toBe(gated)
  })
  it('a gated provider still has computed components (the accrual the card shows)', () => {
    const r = scoreProvider(P({ closed_orders: 1 }))
    expect(r.score).toBeNull()
    expect(r.components.on_time.value).toBe(100)
    expect(r.sample).toEqual({ closed_orders: 1, response_samples: 5 })
  })
  it.each([
    [{ rfqs_with_quotes: 1 }, true],
    [{ closed_orders: 0 }, true],
    [{}, false],
  ])('buyer gate %j → gated %s', (over, gated) => {
    expect(scoreBuyer(B(over)).gated).toBe(gated)
  })
  it('a buyer worked example: 30×75 + 30×100 + 20×100 + 20×100 = 92.5 → 93', () => {
    expect(scoreBuyer(B({ median_confirmation_hours: 36 })).score).toBe(93)
  })
  it('garbage inputs (negative, NaN) are treated as zero, never a crash', () => {
    const r = scoreProvider(P({ delivered_orders: -3, on_time_deliveries: Number.NaN, median_response_hours: -1 }))
    expect(r.components.on_time.value).toBeNull()
    expect(r.components.responsiveness.value).toBeNull()
  })
  it('weightedScore: all null → null; zero weight ignored', () => {
    expect(weightedScore([{ exact: null, weight: 50 }])).toBeNull()
    expect(weightedScore([{ exact: 10, weight: 0 }, { exact: 90, weight: 10 }])).toBe(90)
  })
  it.each([[66.5, 67], [66.49, 66], [0.5, 1], [99.5, 100], [101, 100], [-3, 0]])('roundScore(%s) = %s', (x, y) => expect(roundScore(x)).toBe(y))
})

describe('tips helpers', () => {
  it('weakestComponents: lowest first, ties → heavier weight, nulls skipped', () => {
    const r = scoreProvider(P({ on_time_deliveries: 2, delivered_orders: 4, matches_decided_or_closed: 10, matches_quoted: 5, matches_declined_with_reason: 0, median_response_hours: null }))
    // on_time 50 (w25) and decision_rate 50 (w10) tie → on_time first
    expect(weakestComponents(r.components, PROVIDER_COMPONENTS)).toEqual(['on_time', 'decision_rate'])
  })
  it('weakestComponents respects n', () => {
    expect(weakestComponents(scoreProvider(P()).components, PROVIDER_COMPONENTS, 1)).toHaveLength(1)
  })
  it('biggestMover names the component that moved most; none when nothing moved', () => {
    const a = scoreProvider(P()).components
    const b = scoreProvider(P({ on_time_deliveries: 1 })).components
    expect(biggestMover(a, b, PROVIDER_COMPONENTS)).toBe('on_time')
    expect(biggestMover(a, a, PROVIDER_COMPONENTS)).toBeNull()
    expect(biggestMover(null, a, PROVIDER_COMPONENTS)).toBe('responsiveness')
  })
})

describe('reliability ordering', () => {
  it.each([
    [10_000_000, 90, 10_150_000],
    [9_500_000, 40, 10_355_000],
    [10_000_000, 100, 10_000_000],
    [10_000_000, 0, 11_500_000],
    [10_000_000, null, 10_600_000],
    [333, 67, 349],
  ])('adjusted(%s paise, score %s) = %s paise exactly', (t, s, a) => expect(reliabilityAdjustedTotal(t, s, OPTS)).toBe(a))
  it('k = 0 leaves every total unchanged', () => {
    expect(reliabilityAdjustedTotal(12_345_678, 10, { nullPrior: 60, kBps: 0 })).toBe(12_345_678)
  })
  it('the worked example: a provider 5 % cheaper at score 40 ranks below one at score 90', () => {
    expect(reliabilityOrder([{ id: 'b', normalizedTotalPaise: 9_500_000, providerScore: 40 }, { id: 'a', normalizedTotalPaise: 10_000_000, providerScore: 90 }], OPTS)).toEqual(['a', 'b'])
  })
  it('a much cheaper provider still wins despite a lower score (k caps the effect at 15 %)', () => {
    expect(reliabilityOrder([{ id: 'a', normalizedTotalPaise: 10_000_000, providerScore: 100 }, { id: 'b', normalizedTotalPaise: 8_000_000, providerScore: 0 }], OPTS)).toEqual(['b', 'a'])
  })
  it('a new provider (null) ranks as the neutral prior, between a 40 and a 90', () => {
    const ids = reliabilityOrder([{ id: 'low', normalizedTotalPaise: 10_000_000, providerScore: 40 }, { id: 'new', normalizedTotalPaise: 10_000_000, providerScore: null }, { id: 'high', normalizedTotalPaise: 10_000_000, providerScore: 90 }], OPTS)
    expect(ids).toEqual(['high', 'new', 'low'])
  })
  it('ties break by normalised total, then id — stable across input order', () => {
    const q = [{ id: 'z', normalizedTotalPaise: 5_000_000, providerScore: 60 }, { id: 'y', normalizedTotalPaise: 5_000_000, providerScore: 60 }, { id: 'x', normalizedTotalPaise: 5_000_000, providerScore: 60 }]
    expect(reliabilityOrder(q, OPTS)).toEqual(['x', 'y', 'z'])
    expect(reliabilityOrder([...q].reverse(), OPTS)).toEqual(['x', 'y', 'z'])
  })
  it('priceOrder mirrors the screen: total asc, ties keep input order', () => {
    expect(priceOrder([{ id: 'a', normalizedTotalPaise: 3 }, { id: 'b', normalizedTotalPaise: 1 }, { id: 'c', normalizedTotalPaise: 1 }])).toEqual(['b', 'c', 'a'])
  })
  const quotes = [{ id: 'cheap-weak', normalizedTotalPaise: 3_000_000, providerScore: 30 }, { id: 'dear-strong', normalizedTotalPaise: 3_100_000, providerScore: 95 }]
  it('compareOrdering: switch off → price', () => {
    expect(compareOrdering(quotes, { ...OPTS, enabled: false, thresholdPaise: 2_500_000 })).toEqual({ mode: 'price', ids: ['cheap-weak', 'dear-strong'] })
  })
  it('compareOrdering: below the threshold → price', () => {
    expect(compareOrdering(quotes, { ...OPTS, enabled: true, thresholdPaise: 5_000_000 }).mode).toBe('price')
  })
  it('compareOrdering: one quote → price', () => {
    expect(compareOrdering(quotes.slice(0, 1), { ...OPTS, enabled: true, thresholdPaise: 0 }).mode).toBe('price')
  })
  it('compareOrdering: on and above the threshold → reliability, reordered, and the result carries no score', () => {
    const r = compareOrdering(quotes, { ...OPTS, enabled: true, thresholdPaise: 2_500_000 })
    expect(r).toEqual({ mode: 'reliability', ids: ['dear-strong', 'cheap-weak'] })
    expect(scoreFieldPaths(r)).toEqual([])
  })
})

describe('snapshot contract + privacy guard', () => {
  const snap = () => {
    const r = scoreProvider(P())
    return { version: r.version, score: r.score, gated: r.gated, components: r.components, sample: r.sample, computed_at: '2026-09-23T03:45:00.000Z' }
  }
  it('a computed snapshot parses', () => expect(scoreSnapshotSchema.safeParse(snap()).success).toBe(true))
  it('strict: an extra key is rejected', () => expect(scoreSnapshotSchema.safeParse({ ...snap(), note: 'x' }).success).toBe(false))
  it('a score outside 0..100 or a fractional score is rejected', () => {
    expect(scoreSnapshotSchema.safeParse({ ...snap(), score: 101 }).success).toBe(false)
    expect(scoreSnapshotSchema.safeParse({ ...snap(), score: 50.5 }).success).toBe(false)
  })
  it('another version is rejected', () => expect(scoreSnapshotSchema.safeParse({ ...snap(), version: 'v2' }).success).toBe(false))
  it('scoreFieldPaths finds score fields at any depth and nothing in a clean payload', () => {
    expect(scoreFieldPaths({ rfq: { quotes: [{ id: 'q', providerScore: 80 }] } })).toEqual(['$.rfq.quotes[0].providerScore'])
    expect(scoreFieldPaths({ ordering: { mode: 'price', ids: ['a'] }, quotes: [{ id: 'q', pricePaise: 1 }] })).toEqual([])
  })
})

describe('tips + registries', () => {
  it('a tip for every provider component in every locale, no numbers, no placeholders', () => {
    for (const l of SCORE_TIP_LOCALES) for (const c of PROVIDER_COMPONENTS) {
      const t = SCORE_TIPS[l][c]
      expect(t, `${l}.${c}`).toBeTruthy()
      expect(t).not.toMatch(/\d|\{/)
    }
  })
  it('scoreTip falls back to English for an unknown locale', () => {
    expect(scoreTip('on_time', 'fr')).toBe(SCORE_TIPS.en.on_time)
    expect(scoreTip('on_time', 'hi-IN')).toBe(SCORE_TIPS.hi.on_time)
  })
  it('the seven S2.4 settings are registered with safe defaults (every switch off)', () => {
    const d = AGENT_SETTING_DEFS as Record<string, { default: unknown }>
    expect(d['score_compute_enabled']?.default).toBe(false)
    expect(d['score_card_enabled']?.default).toBe(false)
    expect(d['reliability_rank_enabled']?.default).toBe(false)
    expect(d['growth_nudge_enabled']?.default).toBe(false)
    expect(d['reliability_rank_threshold_paise']?.default).toBe(2_500_000)
    expect(d['reliability_rank_k_bps']?.default).toBe(1500)
    expect(d['score_null_prior']?.default).toBe(60)
  })
  it('score_note is a routine task class; read_own_score is a provider confirm:false GET', () => {
    expect(TASK_CLASS_TIER.score_note).toBe('routine')
    expect(toolsForPersona('provider').find((t) => t.name === 'read_own_score')).toMatchObject({ confirm: false, wraps: 'GET /partner/score' })
    expect(toolsForPersona('buyer').some((t) => t.name === 'read_own_score')).toBe(false)
  })
})

describe('score_note rules (the coaching sentence)', () => {
  it('a note with only input numbers and no promise passes', async () => {
    const { scoreNoteProblems } = await import('../score-note')
    expect(scoreNoteProblems('Your on-time delivery is 40 of 100; set delivery days you can keep.', [40, 100, 25])).toEqual([])
  })
  it('an invented number is refused (Indic digits folded)', async () => {
    const { scoreNoteProblems } = await import('../score-note')
    expect(scoreNoteProblems('Reply within 2 hours to win 35% more work.', [40, 100])).toEqual(['number not in the input: 2', 'number not in the input: 35'])
    expect(scoreNoteProblems('समय पर डिलीवरी ४५ है', [40])).toEqual(['number not in the input: 45'])
  })
  it('promise language in any locale is refused', async () => {
    const { scoreNoteProblems } = await import('../score-note')
    expect(scoreNoteProblems('You are guaranteed more work.', [])).toContain('promise: guarantee')
    expect(scoreNoteProblems('आपके ऑर्डर बढ़ जाएंगे, पक्का।', []).some((p) => p.startsWith('promise:'))).toBe(true)
  })
  it('the stub note names the weakest component tip, stays ≤ 280, and passes its own rules in every locale', async () => {
    const { stubScoreNote, scoreNoteProblems, SCORE_NOTE_MAX } = await import('../score-note')
    for (const l of ['en', 'hi', 'te', 'ta']) for (const c of [...PROVIDER_COMPONENTS, null] as const) {
      const n = stubScoreNote(l, c)
      expect(n.note.length).toBeLessThanOrEqual(SCORE_NOTE_MAX)
      expect(scoreNoteProblems(n.note, [])).toEqual([])
    }
  })
})

describe('a brand-new provider is neutral, never scored 0 (ADR-010 §4)', () => {
  const blank: ProviderScoreInputs = { response_samples: 0, median_response_hours: null, delivered_orders: 0, on_time_deliveries: 0, completed_orders: 0, confirmed_by_buyer: 0, auto_accepted: 0, closed_orders: 0, disputes_at_fault: 0, matches_decided_or_closed: 0, matches_quoted: 0, matches_declined_with_reason: 0 }
  it('no activity at all → score null (gated), every component null — never 0', () => {
    const r = scoreProvider(blank)
    expect(r.score).toBeNull()
    expect(r.gated).toBe(true)
    expect(PROVIDER_COMPONENTS.every((k) => r.components[k].value === null)).toBe(true)
  })
  it('no score row, a gated snapshot and a brand-new provider all rank exactly as the neutral prior', () => {
    const neutral = reliabilityAdjustedTotal(2_950_000, 60, OPTS)
    expect(reliabilityAdjustedTotal(2_950_000, null, OPTS)).toBe(neutral)
    expect(reliabilityAdjustedTotal(2_950_000, scoreProvider(blank).score, OPTS)).toBe(neutral)
    // a 0 would add the full 15 % — the newcomer penalty this rule exists to prevent
    expect(reliabilityAdjustedTotal(2_950_000, 0, OPTS)).toBeGreaterThan(neutral)
  })
  it('a newcomer between a strong and a weak provider sorts by the neutral prior, not to the bottom', () => {
    const ids = reliabilityOrder([{ id: 'strong', normalizedTotalPaise: 3_000_000, providerScore: 100 }, { id: 'weak', normalizedTotalPaise: 2_900_000, providerScore: 44 }, { id: 'new', normalizedTotalPaise: 2_950_000, providerScore: null }], OPTS)
    expect(ids).toEqual(['strong', 'new', 'weak'])
    expect(reliabilityOrder([{ id: 'strong', normalizedTotalPaise: 3_000_000, providerScore: 100 }, { id: 'weak', normalizedTotalPaise: 2_900_000, providerScore: 44 }, { id: 'new', normalizedTotalPaise: 2_950_000, providerScore: 0 }], OPTS)).toEqual(['strong', 'weak', 'new'])
  })
})
