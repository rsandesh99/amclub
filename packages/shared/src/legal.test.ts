import { describe, it, expect } from 'vitest'
import { LEGAL_VERSIONS, PROVIDER_ADDENDUM_GOODS_VERSION, effectiveLegalVersions, providerAddendumSections } from './legal'

describe('legal versions — Mart Launch Gate item 4', () => {
  it('flag off: services versions, nobody re-accepts', () => {
    expect(effectiveLegalVersions({ martEnabled: false })).toEqual(LEGAL_VERSIONS)
    expect(providerAddendumSections({ martEnabled: false })).toBe(5)
  })
  it('flag on: only the provider addendum bumps, to the goods-schedule version', () => {
    const v = effectiveLegalVersions({ martEnabled: true })
    expect(v.provider_addendum).toBe(PROVIDER_ADDENDUM_GOODS_VERSION)
    expect(v.provider_addendum > LEGAL_VERSIONS.provider_addendum).toBe(true)
    expect(v.terms).toBe(LEGAL_VERSIONS.terms)
    expect(v.privacy).toBe(LEGAL_VERSIONS.privacy)
    expect(providerAddendumSections({ martEnabled: true })).toBe(8)
  })
})
