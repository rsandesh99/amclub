import { describe, expect, it } from 'vitest'
import { contentNumbersProblems, contentTranslateRequestSchema, isMachineTranslated } from '../index'

describe('E14 FR-14.3 — provider content translation rules', () => {
  it('numbers are copied, never translated', () => {
    expect(contentNumbersProblems('GST filing for 12 months, 2 revisions', 'GST ఫైలింగ్ 12 నెలలు, 2 సవరణలు')).toEqual([])
    expect(contentNumbersProblems('Delivered in 7 days', 'ఏడు రోజుల్లో')[0]).toMatch(/^numbers_changed/)
    expect(contentNumbersProblems('Up to ₹1,50,000 turnover', 'Up to ₹1,50,000 టర్నోవర్')).toEqual([])
    expect(contentNumbersProblems('Up to ₹1,50,000 turnover', 'Up to ₹150000 టర్నోవర్')[0]).toMatch(/^numbers_changed/)
    expect(contentNumbersProblems('In 7 days', '౭ రోజుల్లో')).toContain('native_digits')
    expect(contentNumbersProblems('Plain words', 'సాధారణ పదాలు 5')[0]).toMatch(/^numbers_changed/)
  })
  it('a package request needs its id; a profile request does not', () => {
    expect(contentTranslateRequestSchema.safeParse({ subjectKind: 'package', lang: 'te' }).success).toBe(false)
    expect(contentTranslateRequestSchema.safeParse({ subjectKind: 'profile', lang: 'ta' }).success).toBe(true)
    expect(contentTranslateRequestSchema.safeParse({ subjectKind: 'profile', lang: 'en' }).success).toBe(false)
  })
  it('only an approved machine translation in the reader\'s own locale is labelled', () => {
    const s = { title: { te: 'machine_approved' as const, hi: 'provider' as const } }
    expect(isMachineTranslated(s, 'title', 'te')).toBe(true)
    expect(isMachineTranslated(s, 'title', 'hi')).toBe(false)
    expect(isMachineTranslated(s, 'title', 'en')).toBe(false)
    expect(isMachineTranslated(s, 'ideal_for', 'te')).toBe(false)
    expect(isMachineTranslated(null, 'title', 'te')).toBe(false)
  })
})
