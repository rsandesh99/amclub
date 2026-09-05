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
  /** Optional Telugu label (S3.3). Renderers fall back label_te ?? label_en. */
  label_te?: string
  required: boolean
  options?: string[]
  placeholder_en?: string
  placeholder_hi?: string
}

export interface RfqTemplate {
  fields: RfqTemplateField[]
}

/** Localized RFQ field label with en fallback (S3.3). te/hi are optional in
 *  the data; a missing translation renders English, never a raw field name.
 *  Accepts any field carrying label_* (RfqTemplateField or the catalog page's
 *  looser RequirementField, whose labels are all optional). */
export function rfqFieldLabel(
  f: { name?: string; label_en?: string; label_hi?: string; label_te?: string },
  locale: string,
): string {
  if (locale === 'te') return f.label_te ?? f.label_en ?? f.name ?? ''
  if (locale === 'hi') return f.label_hi || f.label_en || f.name || ''
  return f.label_en ?? f.name ?? ''
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
