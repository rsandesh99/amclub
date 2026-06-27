/**
 * RFQ template field shape (seeded per category in `categories.rfq_template`)
 * and the canonical pre-payment contact-masking used on quote-thread messages
 * (§9.3 — anti-disintermediation). The masking is a pure function so both
 * surfaces and the server agree, and it's unit-testable.
 */

export type RfqFieldType = 'text' | 'textarea' | 'select'

export interface RfqTemplateField {
  name: string
  type: RfqFieldType
  label_en: string
  label_hi: string
  required: boolean
  options?: string[]
  placeholder_en?: string
  placeholder_hi?: string
}

export interface RfqTemplate {
  fields: RfqTemplateField[]
}

/** RFQ is still accepting quotes (provider can see/quote) — open or quoted. */
export function rfqIsActive(status: string): boolean {
  return status === 'open' || status === 'quoted'
}

// ── Contact masking (§9.3) ────────────────────────────────────────────────────

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// 10-digit Indian mobile, optional +91 and space/dash separators between digits.
const PHONE_RE = /(?:\+?91[\s-]?)?(?:\d[\s-]?){10}/g

/**
 * Redact phone numbers and emails from free text BEFORE a pre-payment quote
 * message is stored (so contact details can't be exchanged off-platform).
 * Returns the masked text and whether anything was masked.
 */
export function redactContactInfo(input: string): { text: string; redacted: boolean } {
  let redacted = false

  let text = input.replace(EMAIL_RE, () => {
    redacted = true
    return '[contact hidden]'
  })

  text = text.replace(PHONE_RE, (match) => {
    const digits = match.replace(/\D/g, '')
    // Only mask things that look like an Indian mobile (avoids gutting amounts/years).
    if (/^(?:91)?[6-9]\d{9}$/.test(digits)) {
      redacted = true
      return '[contact hidden]'
    }
    return match
  })

  return { text, redacted }
}
