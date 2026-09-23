/**
 * Indian mobile number normalisation — the ONE rule for phone fields on web
 * and mobile (UX audit Part D). A pasted "+91 98765 43210" must become the
 * national "9876543210", never "9198765432" (the old strip-then-keep-first-10
 * bug that produced a valid-looking wrong number).
 *
 * Pure string functions; no runtime deps.
 */

/**
 * Normalise any typed or pasted Indian mobile number to its national form
 * (at most 10 digits, no prefix). Strips every non-digit (`+`, spaces,
 * dashes, brackets), leading trunk zeros, and a leading `91` country code
 * when more than 10 digits remain. The result may be shorter than 10 digits
 * while the user is still typing — validate it with `phoneSchema`.
 */
export function normalizeIndianPhone(raw: string): string {
  let digits = (raw ?? '').replace(/\D/g, '')
  // International / trunk prefix: "00 91 …" or "0 98765 …".
  digits = digits.replace(/^0+/, '')
  if (digits.length > 10 && digits.startsWith('91')) {
    digits = digits.slice(2)
    // "+91 0 98765 43210" — a trunk zero after the country code.
    digits = digits.replace(/^0+/, '')
  }
  return digits.slice(0, 10)
}

/** E.164 form of a national Indian mobile number: "+91" + 10 digits.
 *  Accepts anything `normalizeIndianPhone` accepts. */
export function toE164India(national: string): string {
  return `+91${normalizeIndianPhone(national)}`
}
