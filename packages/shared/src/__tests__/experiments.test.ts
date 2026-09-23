import { describe, expect, it } from 'vitest'
import { experienceBucket, experienceFlagEnvVar, isExperienceOn, parseExperienceSetting } from '../experiments'

describe('experience flags (PRD §7.9)', () => {
  it('parses off / on / percent; junk is off', () => {
    expect(parseExperienceSetting(undefined)).toEqual({ mode: 'off' })
    expect(parseExperienceSetting('on')).toEqual({ mode: 'on' })
    expect(parseExperienceSetting('100')).toEqual({ mode: 'on' })
    expect(parseExperienceSetting('0')).toEqual({ mode: 'off' })
    expect(parseExperienceSetting('10')).toEqual({ mode: 'percent', percent: 10 })
    expect(parseExperienceSetting('yes please')).toEqual({ mode: 'off' })
  })
  it('env var names', () => expect(experienceFlagEnvVar('shell')).toBe('EXP_V3_SHELL'))
  it('buckets are stable and roughly uniform', () => {
    expect(experienceBucket('shell', 'u1')).toBe(experienceBucket('shell', 'u1'))
    let inTen = 0
    for (let i = 0; i < 5000; i++) if (experienceBucket('shell', `user-${i}`) < 10) inTen++
    expect(inTen).toBeGreaterThan(400)
    expect(inTen).toBeLessThan(600)
  })
  it('percent needs a user; anonymous (static) pages only see "on"', () => {
    expect(isExperienceOn('shell', { mode: 'percent', percent: 99 })).toBe(false)
    expect(isExperienceOn('shell', { mode: 'on' })).toBe(true)
  })
  it('the cohort sees every flag, even when off', () => {
    expect(isExperienceOn('compare', { mode: 'off' }, { userId: 'x', inCohort: true })).toBe(true)
  })
})

import { escapeLike, universalSearchQuerySchema } from '../universal-search'
describe('universal search contract (N3)', () => {
  it('escapes LIKE wildcards', () => expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\'))
  it('needs 2–80 characters', () => {
    expect(universalSearchQuerySchema.safeParse({ q: 'g' }).success).toBe(false)
    expect(universalSearchQuerySchema.safeParse({ q: ' gst ' }).data?.q).toBe('gst')
  })
})
