/**
 * GSTIN validation (Phase 8 §7 — client-side checksum hint; the server keeps
 * its own Zod validation as the authority).
 *
 * A GSTIN is 15 chars: 2-digit state code + 10-char PAN + entity digit +
 * 'Z' + a mod-36 check character computed over the first 14 chars
 * (Luhn-mod-36 variant: alternate ×1/×2 factors, digit sums in base 36).
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

// 2-digit state + 10-char PAN + entity code [1-9A-Z] + literal 'Z' + check char.
export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

/** Format-only check (what the server regex enforces). */
export function isGstinFormat(gstin: string): boolean {
  return GSTIN_PATTERN.test(gstin.toUpperCase())
}

/** Full validation: format + mod-36 check character. */
export function isValidGstin(gstin: string): boolean {
  const g = gstin.toUpperCase()
  if (!GSTIN_PATTERN.test(g)) return false
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const value = ALPHABET.indexOf(g[i]!)
    if (value < 0) return false
    const product = value * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(product / 36) + (product % 36)
  }
  const check = (36 - (sum % 36)) % 36
  return ALPHABET[check] === g[14]
}
