import { describe, expect, it } from 'vitest'
import {
  CATEGORY_SLUGS,
  daysBetween,
  dueReminderThreshold,
  isSpecializationOf,
  LICENCE_TYPE_KEYS,
  LICENCE_TYPES,
  licenceCreateSchema,
  obligationsFor,
  orderLicenceFactsSchema,
  renewHref,
  type CategorySlug,
  type ObligationRule,
} from '../index'

describe('E9b licence types', () => {
  it('every type routes to a real category (and a real service of it)', () => {
    for (const k of LICENCE_TYPE_KEYS) {
      const r = LICENCE_TYPES[k]
      expect(CATEGORY_SLUGS).toContain(r.category)
      if (r.service) expect(isSpecializationOf(r.category as CategorySlug, r.service)).toBe(true)
    }
    expect(renewHref('fssai')).toBe('/services/company-registrations/fssai-license')
    expect(renewHref('fire_noc')).toBe('/services/government-licensing')
  })

  it('the migration’s CHECK lists exactly these types', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const sql = readFileSync(resolve(__dirname, '../../../db/src/migrations/0054_licences_obligations.sql'), 'utf8')
    const lists = [...sql.matchAll(/licence_type IN \(([^)]*)\)/g)].map((m) => m[1]!.split(',').map((x) => x.trim().replace(/'/g, '')).sort())
    expect(lists.length).toBe(3)
    for (const l of lists) expect(l).toEqual([...LICENCE_TYPE_KEYS].sort())
  })
})

describe('E9b licence input', () => {
  it('manual: type required, expiry not before issue; or a finished order', () => {
    expect(licenceCreateSchema.safeParse({ licenceType: 'fssai', number: '10019022003456', expiresOn: '2027-11-14' }).success).toBe(true)
    expect(licenceCreateSchema.safeParse({ licenceType: 'fssai', issuedOn: '2027-01-02', expiresOn: '2027-01-01' }).success).toBe(false)
    expect(licenceCreateSchema.safeParse({ licenceType: 'passport' }).success).toBe(false)
    expect(licenceCreateSchema.safeParse({ fromOrderId: '11111111-1111-4111-8111-111111111111' }).success).toBe(true)
    expect(licenceCreateSchema.safeParse({ licenceType: 'fssai', fromOrderId: '11111111-1111-4111-8111-111111111111' }).success).toBe(false)
  })
  it('a provider records a number (the expiry is optional)', () => {
    expect(orderLicenceFactsSchema.safeParse({ licenceType: 'fssai', number: 'X1' }).success).toBe(true)
    expect(orderLicenceFactsSchema.safeParse({ licenceType: 'fssai' }).success).toBe(false)
  })
})

describe('E9b reminders — 60 / 30 / 7, once each', () => {
  it('counts IST calendar days', () => {
    expect(daysBetween('2026-09-23', '2026-10-23')).toBe(30)
    expect(daysBetween('2026-09-23', '2026-09-22')).toBe(-1)
  })
  it('sends the one threshold that is due, never a stale larger one', () => {
    expect(dueReminderThreshold(61)).toBeNull()
    expect(dueReminderThreshold(60)).toBe(60)
    expect(dueReminderThreshold(45, [60])).toBeNull()
    expect(dueReminderThreshold(30, [60])).toBe(30)
    expect(dueReminderThreshold(30, [60, 30])).toBeNull()
    expect(dueReminderThreshold(5)).toBe(7) // added late: only the 7-day one
    expect(dueReminderThreshold(0, [60, 30])).toBe(7)
    expect(dueReminderThreshold(-1)).toBeNull() // lapsed
    expect(dueReminderThreshold(null)).toBeNull() // no expiry
  })
})

describe('E9b "What do I need?" — a routing checklist', () => {
  const rule = (p: Partial<ObligationRule> & Pick<ObligationRule, 'licenceType'>): ObligationRule => ({
    id: '11111111-1111-4111-8111-111111111111', activity: null, state: null, sizeBand: null, categorySlug: 'government-licensing', sourceUrl: 'https://example.gov.in/', reviewedBy: 'CA', reviewedAt: '2026-09-01T00:00:00Z', ...p,
  })
  it('null dimensions match anything; set ones must match', () => {
    const rules = [rule({ licenceType: 'udyam' }), rule({ licenceType: 'factory_licence', activity: 'manufacturing' }), rule({ licenceType: 'trade_licence', state: 'TS' })]
    const got = obligationsFor({ activity: 'manufacturing', state: 'MH', sizeBand: '1-9' }, rules).map((r) => r.licenceType)
    expect(got).toEqual(['udyam', 'factory_licence'])
  })
  it('an unknown business fact never matches a rule that sets it', () => {
    expect(obligationsFor({ activity: null, state: null, sizeBand: null }, [rule({ licenceType: 'factory_licence', activity: 'manufacturing' })])).toEqual([])
  })
  it('one row per licence: the most specific rule wins', () => {
    const general = rule({ licenceType: 'trade_licence', categorySlug: 'a' })
    const specific = rule({ licenceType: 'trade_licence', state: 'TS', categorySlug: 'b' })
    const got = obligationsFor({ activity: 'trade', state: 'TS', sizeBand: null }, [general, specific])
    expect(got).toHaveLength(1)
    expect(got[0]!.categorySlug).toBe('b')
  })
})
