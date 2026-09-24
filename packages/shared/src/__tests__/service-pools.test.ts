import { describe, expect, it } from 'vitest'
import {
  AGENT_NAMES,
  AI_DECISION_FEATURES,
  POOL_MEMBER_ACTION_MAP,
  POOL_TIMING_DEFAULT,
  SERVICE_POOL_STATUSES,
  SERVICE_POOL_TRANSITIONS,
  achievedTier,
  agentSettingDefault,
  canTransitionServicePool,
  clusterPoolCandidates,
  memberActionAllowed,
  parseAgentSetting,
  planPoolClose,
  poolCandidateEligible,
  poolCandidateFits,
  poolClosesAt,
  poolOfferSchema,
  poolTierProblems,
  poolTierViews,
  quoteChargeAmounts,
  type PoolCandidate,
} from '../index'

const NOW = new Date('2026-09-24T06:00:00Z')
const H = 3600_000
const iso = (msFromNow: number) => new Date(NOW.getTime() + msFromNow).toISOString()

function cand(over: Partial<PoolCandidate> & { rfqId: string; msmeId: string }): PoolCandidate {
  return {
    categoryId: 'cat-tax',
    serviceSlug: 'gstr-9',
    state: 'TS',
    hasMustHaves: false,
    createdAt: iso(-2 * H),
    expiresAt: iso(70 * H),
    ...over,
  }
}

describe('S3.4 registry', () => {
  it('demand_aggregation ships dark and its settings are registered with launch defaults', () => {
    expect(AGENT_NAMES).toContain('demand_aggregation')
    expect((agentSettingDefault('agents_enabled') as Record<string, boolean>)['demand_aggregation']).toBe(false)
    expect(agentSettingDefault('pool_min_members')).toBe(3)
    expect(agentSettingDefault('pool_max_members')).toBe(20)
    expect(agentSettingDefault('pool_form_hours')).toBe(POOL_TIMING_DEFAULT.formHours)
    expect(agentSettingDefault('pool_open_hours')).toBe(POOL_TIMING_DEFAULT.openHours)
    expect(agentSettingDefault('pool_pay_buffer_hours')).toBe(POOL_TIMING_DEFAULT.payBufferHours)
    expect(parseAgentSetting('pool_min_members', 1).ok).toBe(false)
    expect(parseAgentSetting('pool_max_members', 51).ok).toBe(false)
    expect(parseAgentSetting('pool_open_hours', 5).ok).toBe(false)
  })

  it('the buyer\'s join is an ai_decisions feature', () => {
    expect(AI_DECISION_FEATURES).toContain('demand_pool')
  })
})

describe('the pool machine', () => {
  it('only the ADR 024 edges exist; terminal states have none', () => {
    const edges = SERVICE_POOL_STATUSES.flatMap((f) => SERVICE_POOL_TRANSITIONS[f].map((t) => `${f}>${t}`)).sort()
    expect(edges).toEqual(['closing>closed', 'forming>cancelled', 'forming>lapsed', 'forming>open', 'open>cancelled', 'open>closing'].sort())
    expect(canTransitionServicePool('open', 'closed')).toBe(false) // a close always passes through closing
    expect(canTransitionServicePool('closing', 'cancelled')).toBe(false) // a started close is finished, never cancelled
  })

  it('members act only while the pool is forming or open, from the right status', () => {
    expect(memberActionAllowed('join', 'invited', 'forming')).toBe(true)
    expect(memberActionAllowed('join', 'left', 'open')).toBe(true)
    expect(memberActionAllowed('join', 'dismissed', 'open')).toBe(false)
    expect(memberActionAllowed('leave', 'joined', 'open')).toBe(true)
    expect(memberActionAllowed('leave', 'joined', 'closing')).toBe(false)
    expect(memberActionAllowed('dismiss', 'invited', 'forming')).toBe(true)
    expect(memberActionAllowed('dismiss', 'joined', 'forming')).toBe(false)
    expect(POOL_MEMBER_ACTION_MAP.join.to).toBe('joined')
  })
})

describe('tiers', () => {
  const ok = [{ min_members: 1, price_paise: 10_000_00 }, { min_members: 3, price_paise: 8_500_00 }, { min_members: 8, price_paise: 7_000_00 }]

  it('a coherent schedule has no problems', () => {
    expect(poolTierProblems(ok, 20)).toEqual([])
    expect(poolTierProblems([{ min_members: 1, price_paise: 5_000_00 }], 20)).toEqual([])
  })

  it('names every incoherence', () => {
    expect(poolTierProblems([{ min_members: 2, price_paise: 9_000_00 }], 20)).toContain('first_tier_not_one')
    expect(poolTierProblems([ok[0]!, { min_members: 1, price_paise: 9_000_00 }], 20)).toContain('thresholds_not_increasing')
    expect(poolTierProblems([ok[0]!, { min_members: 3, price_paise: 10_000_00 }], 20)).toContain('prices_not_decreasing')
    expect(poolTierProblems([ok[0]!, { min_members: 3, price_paise: 11_000_00 }], 20)).toContain('prices_not_decreasing')
    expect(poolTierProblems(ok, 5)).toContain('threshold_over_max')
    expect(poolTierProblems([], 20)).toContain('first_tier_not_one')
  })

  it('the schema caps tiers at 3 and requires GST and validity', () => {
    const base = { tiers: ok, delivery_days: 5, scope: 'GSTR-9 annual return preparation and filing', gst_included: false, valid_until: '2026-10-31' }
    expect(poolOfferSchema.safeParse(base).success).toBe(true)
    expect(poolOfferSchema.safeParse({ ...base, tiers: [...ok, { min_members: 12, price_paise: 6_000_00 }] }).success).toBe(false)
    const without = (key: keyof typeof base) => Object.fromEntries(Object.entries(base).filter(([k]) => k !== key))
    expect(poolOfferSchema.safeParse(without('gst_included')).success).toBe(false)
    expect(poolOfferSchema.safeParse(without('valid_until')).success).toBe(false)
    expect(poolOfferSchema.safeParse({ ...base, counter_offer: 1 }).success).toBe(false) // strict: no stray fields
  })

  it('achievedTier = the highest threshold the count reaches; nothing below one', () => {
    expect(achievedTier(ok, 0)).toBeNull()
    expect(achievedTier(ok, 1)?.price_paise).toBe(10_000_00)
    expect(achievedTier(ok, 2)?.price_paise).toBe(10_000_00)
    expect(achievedTier(ok, 3)?.price_paise).toBe(8_500_00)
    expect(achievedTier(ok, 7)?.price_paise).toBe(8_500_00)
    expect(achievedTier(ok, 20)?.price_paise).toBe(7_000_00)
    // order of the array does not matter
    expect(achievedTier([...ok].reverse(), 4)?.price_paise).toBe(8_500_00)
  })

  it('each tier view is the checkout\'s own rule for a quote at that price, in both GST modes', () => {
    for (const gstIncluded of [false, true]) {
      const views = poolTierViews(ok, gstIncluded, 1000)
      expect(views.map((v) => v.minMembers)).toEqual([1, 3, 8])
      for (const v of views) {
        const a = quoteChargeAmounts({ pricePaise: v.pricePaise, gstIncluded, commissionBps: 1000 })
        expect(v.totalPaise).toBe(a.totalPaise)
        expect(v.gstPaise).toBe(a.gstPaise)
      }
    }
    // GST included: the buyer pays exactly the stated price (ADR 015)
    expect(poolTierViews(ok, true, 1000)[0]!.totalPaise).toBe(10_000_00)
  })
})

describe('detection', () => {
  const timing = POOL_TIMING_DEFAULT

  it('a request needs a service, a state, no must-haves and room on its clock for the whole pool', () => {
    expect(poolCandidateEligible(cand({ rfqId: 'r1', msmeId: 'm1' }), NOW, timing)).toBe(true)
    expect(poolCandidateEligible(cand({ rfqId: 'r1', msmeId: 'm1', serviceSlug: null }), NOW, timing)).toBe(false)
    expect(poolCandidateEligible(cand({ rfqId: 'r1', msmeId: 'm1', state: null }), NOW, timing)).toBe(false)
    expect(poolCandidateEligible(cand({ rfqId: 'r1', msmeId: 'm1', hasMustHaves: true }), NOW, timing)).toBe(false)
    expect(poolCandidateEligible(cand({ rfqId: 'r1', msmeId: 'm1', expiresAt: iso(48 * H) }), NOW, timing)).toBe(true) // exactly 12+24+12
    expect(poolCandidateEligible(cand({ rfqId: 'r1', msmeId: 'm1', expiresAt: iso(48 * H - 1) }), NOW, timing)).toBe(false)
  })

  it('clusters by (category, service, state), one request per buyer (their newest), earliest first, capped', () => {
    const cs = [
      cand({ rfqId: 'a', msmeId: 'm1', createdAt: iso(-5 * H) }),
      cand({ rfqId: 'b', msmeId: 'm2', createdAt: iso(-4 * H) }),
      cand({ rfqId: 'c', msmeId: 'm3', createdAt: iso(-3 * H) }),
      cand({ rfqId: 'c2', msmeId: 'm3', createdAt: iso(-1 * H) }), // m3's newer request replaces c
      cand({ rfqId: 'd', msmeId: 'm4', createdAt: iso(-2 * H), state: 'AP' }), // another state
      cand({ rfqId: 'e', msmeId: 'm5', createdAt: iso(-2 * H), serviceSlug: 'itr' }), // another service
    ]
    const out = clusterPoolCandidates(cs, { now: NOW, minMembers: 3, maxMembers: 20, timing })
    expect(out).toHaveLength(1)
    expect(out[0]!.rfqIds).toEqual(['a', 'b', 'c2'])
    expect(out[0]).toMatchObject({ categoryId: 'cat-tax', serviceSlug: 'gstr-9', state: 'TS' })
    expect(clusterPoolCandidates(cs, { now: NOW, minMembers: 4, maxMembers: 20, timing })).toEqual([])
    expect(clusterPoolCandidates(cs, { now: NOW, minMembers: 2, maxMembers: 2, timing })[0]!.rfqIds).toEqual(['a', 'b'])
  })

  it('two requests from one buyer never make a group of two', () => {
    const cs = [cand({ rfqId: 'a', msmeId: 'm1' }), cand({ rfqId: 'b', msmeId: 'm1', createdAt: iso(-1 * H) }), cand({ rfqId: 'c', msmeId: 'm2' })]
    expect(clusterPoolCandidates(cs, { now: NOW, minMembers: 3, maxMembers: 20, timing })).toEqual([])
  })

  it('is deterministic whatever the input order', () => {
    const cs = Array.from({ length: 9 }, (_, i) => cand({ rfqId: `r${i}`, msmeId: `m${i % 7}`, createdAt: iso(-(i + 1) * H), state: i % 2 ? 'TS' : 'KA' }))
    const a = clusterPoolCandidates(cs, { now: NOW, minMembers: 2, maxMembers: 20, timing })
    const b = clusterPoolCandidates([...cs].reverse(), { now: NOW, minMembers: 2, maxMembers: 20, timing })
    expect(b).toEqual(a)
  })

  it('a late request fits a forming pool by the full window, an open pool by its fixed close', () => {
    const c = cand({ rfqId: 'late', msmeId: 'm9', expiresAt: iso(40 * H) })
    expect(poolCandidateFits(c, { status: 'forming', closesAt: null }, NOW, timing)).toBe(false) // needs 48 h
    expect(poolCandidateFits(c, { status: 'open', closesAt: iso(28 * H) }, NOW, timing)).toBe(true) // 40 − 12 ≥ 28
    expect(poolCandidateFits(c, { status: 'open', closesAt: iso(29 * H) }, NOW, timing)).toBe(false)
    expect(poolCandidateFits(c, { status: 'closing', closesAt: iso(1 * H) }, NOW, timing)).toBe(false)
  })

  it('closes at the open window, or earlier when a member would expire inside the pay buffer', () => {
    expect(poolClosesAt(NOW, [iso(70 * H), iso(60 * H)], timing).toISOString()).toBe(iso(24 * H))
    expect(poolClosesAt(NOW, [iso(70 * H), iso(30 * H)], timing).toISOString()).toBe(iso(18 * H))
  })
})

describe('the close plan', () => {
  const tiers = [{ min_members: 1, price_paise: 10_000_00 }, { min_members: 3, price_paise: 8_000_00 }]

  it('counts only claimed members per offer and prices each offer at the tier its own count reaches', () => {
    const plan = planPoolClose(
      [{ offerId: 'A', tiers }, { offerId: 'B', tiers }, { offerId: 'C', tiers }],
      [{ offerId: 'A' }, { offerId: 'A' }, { offerId: 'A' }, { offerId: 'B' }],
    )
    expect(plan).toEqual([
      { offerId: 'A', count: 3, tier: { min_members: 3, price_paise: 8_000_00 } },
      { offerId: 'B', count: 1, tier: { min_members: 1, price_paise: 10_000_00 } },
      { offerId: 'C', count: 0, tier: null },
    ])
  })

  it('a skipped member lowers the count and can drop the tier (never the other way)', () => {
    const three = planPoolClose([{ offerId: 'A', tiers }], [{ offerId: 'A' }, { offerId: 'A' }, { offerId: 'A' }])[0]!
    const two = planPoolClose([{ offerId: 'A', tiers }], [{ offerId: 'A' }, { offerId: 'A' }])[0]!
    expect(three.tier!.price_paise).toBeLessThan(two.tier!.price_paise)
  })
})
