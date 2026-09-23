import { describe, expect, it } from 'vitest'
import { GROWTH_PROFILE_FIELDS, growthNudgeLine, growthNudgeSchema, pickGrowthNudge, providerProfileGaps, type GrowthFacts } from '../munshi-growth'
import { PROVIDER_COMPONENTS } from '../score'

const none: GrowthFacts = { profileGaps: [], demand: [], weakest: null, rise: null }

describe('pickGrowthNudge — one deterministic nudge, in priority order', () => {
  it('a profile gap wins over everything else (first in GROWTH_PROFILE_FIELDS order)', () => {
    expect(pickGrowthNudge({ ...none, profileGaps: ['city', 'about'], demand: [{ category_slug: 'legal', count: 9 }], weakest: { component: 'on_time', value: 20 } })).toEqual({ kind: 'profile_field', field: 'about' })
  })
  it('category demand next: the largest count ≥ 3; ties by slug', () => {
    expect(pickGrowthNudge({ ...none, demand: [{ category_slug: 'b', count: 4 }, { category_slug: 'a', count: 4 }, { category_slug: 'c', count: 2 }] })).toEqual({ kind: 'category_demand', category_slug: 'a', count: 4 })
  })
  it('demand below 3 does not count', () => {
    expect(pickGrowthNudge({ ...none, demand: [{ category_slug: 'a', count: 2 }] })).toBeNull()
  })
  it('the weakest tip only for a real weakness (< 70)', () => {
    expect(pickGrowthNudge({ ...none, weakest: { component: 'on_time', value: 69 } })).toEqual({ kind: 'score_tip', component: 'on_time' })
    expect(pickGrowthNudge({ ...none, weakest: { component: 'on_time', value: 70 } })).toBeNull()
  })
  it('otherwise a rise of ≥ 5 points is celebrated (the tip bar makes this reachable)', () => {
    expect(pickGrowthNudge({ ...none, weakest: { component: 'on_time', value: 85 }, rise: { component: 'on_time', points: 6 } })).toEqual({ kind: 'score_rise', component: 'on_time', points: 6 })
    expect(pickGrowthNudge({ ...none, rise: { component: 'on_time', points: 4 } })).toBeNull()
  })
  it('nothing worth saying → null', () => expect(pickGrowthNudge(none)).toBeNull())
})

describe('the lines', () => {
  const nudges = [
    ...GROWTH_PROFILE_FIELDS.map((field) => ({ kind: 'profile_field' as const, field })),
    { kind: 'category_demand' as const, category_slug: 'legal-compliance', count: 5 },
    ...PROVIDER_COMPONENTS.map((component) => ({ kind: 'score_tip' as const, component })),
    ...PROVIDER_COMPONENTS.map((component) => ({ kind: 'score_rise' as const, component, points: 7 })),
  ]
  it('every nudge renders in every locale, no placeholder, parses against the schema', () => {
    for (const n of nudges) {
      expect(growthNudgeSchema.safeParse(n).success, JSON.stringify(n)).toBe(true)
      for (const l of ['en', 'hi', 'te', 'ta']) {
        const line = growthNudgeLine(n, l, 'Legal & compliance')
        expect(line.length).toBeGreaterThan(10)
        expect(line).not.toMatch(/\{|\}|undefined/)
      }
    }
  })
  it('the demand line names the category and the count; the rise line the points', () => {
    expect(growthNudgeLine({ kind: 'category_demand', category_slug: 'legal', count: 5 }, 'en', 'Legal & compliance')).toContain('5 requests for Legal & compliance')
    expect(growthNudgeLine({ kind: 'score_rise', component: 'on_time', points: 7 }, 'hi')).toContain('7')
  })
  it('the schema is strict: a free-text field is refused', () => {
    expect(growthNudgeSchema.safeParse({ kind: 'score_tip', component: 'on_time', text: 'hi' }).success).toBe(false)
  })
})

describe('providerProfileGaps', () => {
  it('a complete profile has no gaps', () => {
    expect(providerProfileGaps({ about: 'We file GST returns for traders and small manufacturers across Andhra.', logo_url: 'x.png', city: 'Guntur', languages: ['te'], years_experience: 6 })).toEqual([])
  })
  it('a short about, no logo, no city, no languages, no experience → every gap in order', () => {
    expect(providerProfileGaps({ about: 'GST', logo_url: null, city: ' ', languages: [], years_experience: null })).toEqual(['about', 'logo', 'city', 'languages', 'years_experience'])
  })
})
