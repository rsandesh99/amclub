import { describe, expect, it } from 'vitest'
import { isGovtDependent, mostChosenTier, packageGroupUpsertSchema, totalBucket, COMPARE_ROWS_MAX } from '../packages-v3'
import { priceDisplay } from '../price-display'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const base = {
  titleI18n: { en: 'GST registration' },
  compareRows: [
    { key: 'gstin', labelI18n: { en: 'GSTIN + certificate' } },
    { key: 'udyam', labelI18n: { en: 'Udyam registration' } },
  ],
  tiers: [
    { packageId: uuid(1), tier: 'basic', idealForI18n: null, compareValues: { gstin: true, udyam: false } },
    { packageId: uuid(2), tier: 'standard', idealForI18n: { en: 'You also need Udyam this week' }, compareValues: { gstin: true, udyam: true } },
  ],
}

describe('packageGroupUpsertSchema (FR-4.1)', () => {
  it('accepts a two-tier group', () => {
    expect(packageGroupUpsertSchema.safeParse(base).success).toBe(true)
  })
  it('refuses more than 12 comparison rows', () => {
    const rows = Array.from({ length: COMPARE_ROWS_MAX + 1 }, (_, i) => ({ key: `r${i}`, labelI18n: { en: `Row ${i}` } }))
    expect(packageGroupUpsertSchema.safeParse({ ...base, compareRows: rows }).success).toBe(false)
  })
  it('refuses a duplicate tier, a duplicate package and an unknown row', () => {
    const dupTier = { ...base, tiers: [base.tiers[0], { ...base.tiers[1], tier: 'basic' }] }
    const dupPkg = { ...base, tiers: [base.tiers[0], { ...base.tiers[1], packageId: uuid(1) }] }
    const unknownRow = { ...base, tiers: [base.tiers[0], { ...base.tiers[1], compareValues: { nope: true } }] }
    for (const v of [dupTier, dupPkg, unknownRow]) expect(packageGroupUpsertSchema.safeParse(v).success).toBe(false)
  })
  it('caps "Choose this if…" at 90 characters and needs 2–3 tiers', () => {
    const long = { ...base, tiers: [base.tiers[0], { ...base.tiers[1], idealForI18n: { en: 'x'.repeat(91) } }] }
    expect(packageGroupUpsertSchema.safeParse(long).success).toBe(false)
    expect(packageGroupUpsertSchema.safeParse({ ...base, tiers: [base.tiers[0]] }).success).toBe(false)
  })
})

describe('isGovtDependent (FR-4.5)', () => {
  it('uses the package override, else the category', () => {
    expect(isGovtDependent(true, null)).toBe(true)
    expect(isGovtDependent(true, false)).toBe(false)
    expect(isGovtDependent(false, true)).toBe(true)
    expect(isGovtDependent(false, undefined)).toBe(false)
  })
})

describe('mostChosenTier (FR-4.6)', () => {
  it('needs n ≥ 10 paid orders and a ≥ 50 % share', () => {
    expect(mostChosenTier({ standard: 9 })).toBeNull()
    expect(mostChosenTier({ basic: 3, standard: 5, premium: 2 })).toBe('standard')
    expect(mostChosenTier({ basic: 4, standard: 4, premium: 2 })).toBeNull()
  })
  it('never labels two tiers on a tie', () => {
    expect(mostChosenTier({ basic: 5, standard: 5 })).toBeNull()
  })
})

describe('priceDisplay member + pill fields', () => {
  it('computes the member price on the server', () => {
    const d = priceDisplay({ pricePaise: 100000, discountBps: 1000, memberExtraDiscountBps: 500 })
    expect(d).toMatchObject({ discountPct: 10, memberPaise: 85500, memberExtraPct: 5 })
    expect(priceDisplay({ pricePaise: 100000, discountBps: 0 }).memberPaise).toBeNull()
  })
})

describe('totalBucket', () => {
  it('buckets without exposing the amount', () => {
    expect(totalBucket(99_900)).toBe('lt_1k')
    expect(totalBucket(353_882)).toBe('1k_5k')
    expect(totalBucket(10_000_000)).toBe('gte_1l')
  })
})
