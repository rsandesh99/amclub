import { describe, expect, it } from 'vitest'
import { normalizeIndianPhone, toE164India } from '../phone'
import { phoneSchema } from '../schemas/index'

describe('normalizeIndianPhone', () => {
  it.each([
    ['+91 98765 43210', '9876543210'],
    ['919876543210', '9876543210'],
    ['09876543210', '9876543210'],
    ['98765-43210', '9876543210'],
    ['+91-98765-43210', '9876543210'],
    ['9876543210', '9876543210'],
    ['(+91) 98765 43210', '9876543210'],
    ['0091 98765 43210', '9876543210'],
    ['+91 0 98765 43210', '9876543210'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeIndianPhone(raw)).toBe(expected)
    expect(phoneSchema.safeParse(normalizeIndianPhone(raw)).success).toBe(true)
  })

  it('never turns a pasted +91 number into a valid-looking wrong one', () => {
    expect(normalizeIndianPhone('+91 98765 43210')).not.toBe('9198765432')
  })

  it('keeps short (still-typing) input as-is, digits only', () => {
    expect(normalizeIndianPhone('98765')).toBe('98765')
    expect(normalizeIndianPhone('987 6')).toBe('9876')
    expect(normalizeIndianPhone('')).toBe('')
    expect(phoneSchema.safeParse(normalizeIndianPhone('98765')).success).toBe(false)
  })

  it('does not strip 91 from a 10-digit national number that starts with 91', () => {
    expect(normalizeIndianPhone('9198765432')).toBe('9198765432')
  })

  it('caps at 10 digits while typing', () => {
    expect(normalizeIndianPhone('98765432109')).toBe('9876543210')
  })
})

describe('toE164India', () => {
  it('prefixes +91 to the national number', () => {
    expect(toE164India('9876543210')).toBe('+919876543210')
    expect(toE164India('+91 98765 43210')).toBe('+919876543210')
    expect(toE164India('09876543210')).toBe('+919876543210')
  })
})
