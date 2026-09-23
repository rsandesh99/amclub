import { describe, expect, it } from 'vitest'
import {
  autofilledFields,
  GST_STATE_CODES,
  INDIAN_STATES,
  normalizeDate,
  normalizeVendorState,
  onboardingNudgeDue,
  stateFromGstin,
  stepsLeft,
  toGstinAutofill,
} from '../index'

describe('E10 stateFromGstin', () => {
  it('maps every GST state code 01–38 to one of our states', () => {
    const values = new Set(INDIAN_STATES.map((s) => s.value))
    for (let i = 1; i <= 38; i++) {
      const code = String(i).padStart(2, '0')
      const st = stateFromGstin(`${code}AABCS1429B1Z5`)
      expect(st, code).not.toBeNull()
      expect(values.has(st!), code).toBe(true)
    }
    expect(Object.keys(GST_STATE_CODES)).toHaveLength(38)
    // every one of our states is reachable from some code
    expect(new Set(Object.values(GST_STATE_CODES)).size).toBe(values.size)
  })
  it('known codes; junk → null', () => {
    expect(stateFromGstin('36AABCS1429B1Z5')).toBe('TS')
    expect(stateFromGstin('27AAACR5055K1Z7')).toBe('MH')
    expect(stateFromGstin('97AAACR5055K1Z7')).toBeNull()
    expect(stateFromGstin('')).toBeNull()
  })
})

describe('E10 GSTIN autofill', () => {
  it('normalises the vendor state (a code or a name inside a jurisdiction string)', () => {
    expect(normalizeVendorState('MH')).toBe('MH')
    expect(normalizeVendorState('State - Telangana, Division - Hyderabad')).toBe('TS')
    expect(normalizeVendorState('Jammu and Kashmir')).toBe('JK')
    expect(normalizeVendorState('Narnia')).toBeNull()
  })
  it('fills 4 fields from a stub and flags a mismatched state (never blocks)', () => {
    const a = toGstinAutofill('36AABCS1429B1Z5', { verified: true, legalName: 'Sharma & Co. LLP', tradeName: 'Sharma & Co.', state: 'MH', registrationDate: '2016-03-01', isActive: true, stub: true })
    expect(autofilledFields(a)).toEqual(['legalName', 'tradeName', 'state', 'registrationDate'])
    expect(a.state).toBe('MH')
    expect(a.stateMismatch).toBe(true)
    expect(a.active).toBe(true)
    const same = toGstinAutofill('27AABCS1429B1Z5', { verified: true, state: 'Maharashtra' })
    expect(same.stateMismatch).toBe(false)
    const noVendorState = toGstinAutofill('36AABCS1429B1Z5', { verified: true })
    expect(noVendorState.state).toBe('TS')
  })
  it('an inactive GSTIN carries its reason', () => {
    const a = toGstinAutofill('36AABCS1429B1Z5', { verified: true, isActive: false, statusText: 'Suspended' })
    expect(a.active).toBe(false)
    expect(a.statusText).toBe('Suspended')
  })
  it('dates: ISO or DD/MM/YYYY', () => {
    expect(normalizeDate('2016-03-01')).toBe('2016-03-01')
    expect(normalizeDate('01/03/2016')).toBe('2016-03-01')
    expect(normalizeDate('March 2016')).toBeNull()
  })
})

describe('E10 stall rule', () => {
  const now = new Date('2026-09-23T12:00:00Z')
  const h = (n: number) => new Date(now.getTime() - n * 3600e3).toISOString()
  it('one nudge after 24 h of silence, a second only after another 24 h, never after submit or 2', () => {
    expect(onboardingNudgeDue({ updatedAt: h(23), submittedAt: null }, [], now)).toBeNull()
    expect(onboardingNudgeDue({ updatedAt: h(25), submittedAt: null }, [], now)).toBe(1)
    expect(onboardingNudgeDue({ updatedAt: h(50), submittedAt: null }, [{ sentAt: h(10) }], now)).toBeNull()
    expect(onboardingNudgeDue({ updatedAt: h(50), submittedAt: null }, [{ sentAt: h(25) }], now)).toBe(2)
    expect(onboardingNudgeDue({ updatedAt: h(99), submittedAt: null }, [{ sentAt: h(80) }, { sentAt: h(50) }], now)).toBeNull()
    expect(onboardingNudgeDue({ updatedAt: h(30), submittedAt: h(1) }, [], now)).toBeNull()
  })
  it('steps left', () => {
    expect(stepsLeft('credentials_bank')).toBe(2)
    expect(stepsLeft('contact')).toBe(4)
  })
})
