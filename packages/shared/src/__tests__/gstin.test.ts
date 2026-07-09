import { describe, expect, it } from 'vitest'
import { isGstinFormat, isValidGstin } from '../gstin'

describe('GSTIN validation (mod-36 checksum)', () => {
  // Verified against public records: the GSTN documentation example and a
  // real GSTIN printed on public invoices (Reliance Industries, Maharashtra).
  const VALID = ['27AAPFU0939F1ZV', '27AAACR5055K1Z7']

  it('accepts known-valid GSTINs', () => {
    for (const g of VALID) {
      expect(isGstinFormat(g), `${g} format`).toBe(true)
      expect(isValidGstin(g), `${g} checksum`).toBe(true)
    }
  })

  it('rejects a correct format with a wrong check character', () => {
    // Flip the final character of a valid GSTIN to every other alphabet char —
    // exactly zero of them may pass (the checksum has a single fixed answer).
    const base = '27AAPFU0939F1Z'
    const passing = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
      .split('')
      .filter((c) => isValidGstin(base + c))
    expect(passing).toEqual(['V'])
  })

  it('rejects transposition typos (the point of the checksum)', () => {
    expect(isValidGstin('72AAPFU0939F1ZV')).toBe(false) // 27 → 72
    expect(isValidGstin('27AAPFU0993F1ZV')).toBe(false) // 39 → 93
  })

  it('rejects bad formats before touching the checksum', () => {
    expect(isValidGstin('')).toBe(false)
    expect(isValidGstin('29ABCDE1234F1Z')).toBe(false) // 14 chars
    expect(isValidGstin('29ABCDE1234F1XZ5')).toBe(false) // 16 chars
    expect(isValidGstin('2AABCDE1234F1Z5')).toBe(false) // letter in state code
  })

  it('is case-insensitive on input', () => {
    expect(isValidGstin('27aapfu0939f1zv')).toBe(true)
  })
})
