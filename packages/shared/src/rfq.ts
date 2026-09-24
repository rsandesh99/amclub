/**
 * RFQ template field shape (seeded per category in `categories.rfq_template`)
 * and the canonical pre-payment contact-masking used on quote-thread messages
 * (§9.3 — anti-disintermediation). The masking is a pure function so both
 * surfaces and the server agree, and it's unit-testable.
 */
import { maskContactInfo } from './contact-mask'

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

/**
 * Redact contact details from free text BEFORE it is stored where the other
 * party can read it (quote threads, clarifications, order messages, statements
 * — so contact details can't be exchanged off-platform). Audit M30: the rules
 * are the ONE shared set in contact-mask.ts (phones incl. Indic / spelled-out /
 * spaced digits, emails, UPI ids, links, handles); each is replaced with
 * `[contact hidden]`. Returns the masked text and whether anything was masked.
 */
export function redactContactInfo(input: string): { text: string; redacted: boolean } {
  const { text, redacted } = maskContactInfo(input)
  return { text, redacted }
}
