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
  /** Optional Telugu / Tamil labels (S3.3, E14). Renderers fall back to label_en. */
  label_te?: string
  label_ta?: string
  required: boolean
  options?: string[]
  /** Optional display labels per option (E14), keyed by the option text: { "Within 1 week": { hi, te, ta } }. */
  option_labels?: Record<string, { hi?: string; te?: string; ta?: string }>
  placeholder_en?: string
  placeholder_hi?: string
  placeholder_te?: string
  placeholder_ta?: string
}

export interface RfqTemplate {
  fields: RfqTemplateField[]
}

type LocalizedField = { name?: string; label_en?: string; label_hi?: string; label_te?: string; label_ta?: string }

/** Localized RFQ field label with en fallback (S3.3, E14). hi / te / ta are
 *  optional in the data; a missing or blank translation renders English
 *  (never Hindi for te / ta), never a raw field name unless there is no label.
 *  Accepts any field carrying label_* (RfqTemplateField or the catalog page's
 *  looser RequirementField, whose labels are all optional). */
export function rfqFieldLabel(f: LocalizedField, locale: string): string {
  const own = locale === 'hi' ? f.label_hi : locale === 'te' ? f.label_te : locale === 'ta' ? f.label_ta : undefined
  if (own && own.trim()) return own
  return f.label_en || f.name || ''
}

/** Localized placeholder with en fallback (same rule as `rfqFieldLabel`). */
export function rfqFieldPlaceholder(
  f: { placeholder_en?: string; placeholder_hi?: string; placeholder_te?: string; placeholder_ta?: string },
  locale: string,
): string {
  const own = locale === 'hi' ? f.placeholder_hi : locale === 'te' ? f.placeholder_te : locale === 'ta' ? f.placeholder_ta : undefined
  if (own && own.trim()) return own
  return f.placeholder_en ?? ''
}

/** Indian money words in the reader's script. `one` follows an amount of exactly 1 ("₹1 crore"). */
const AMOUNT_WORDS: Record<string, { lakh: { one: string; many: string }; crore: { one: string; many: string } }> = {
  hi: { lakh: { one: 'लाख', many: 'लाख' }, crore: { one: 'करोड़', many: 'करोड़' } },
  te: { lakh: { one: 'లక్ష', many: 'లక్షలు' }, crore: { one: 'కోటి', many: 'కోట్లు' } },
  ta: { lakh: { one: 'லட்சம்', many: 'லட்சம்' }, crore: { one: 'கோடி', many: 'கோடி' } },
}

/**
 * RFQ select options are stored (and sent back) as their English text, e.g.
 * "₹20 lakh – ₹1 crore". For DISPLAY only, write the lakh / crore words in the
 * reader's script (hi / te / ta); digits, ₹ and every other character stay as
 * they are, and the option value the form submits is unchanged.
 */
export function localizeAmountWords(text: string, locale: string): string {
  const words = AMOUNT_WORDS[locale]
  if (!words) return text
  return text.replace(/(\d[\d,.]*)?(\s*)\b(lakhs?|lacs?|crores?)\b/gi, (_m, num: string | undefined, space: string, word: string) => {
    const unit = /^cr/i.test(word) ? words.crore : words.lakh
    const one = num !== undefined && Number(num.replace(/,/g, '')) === 1
    return `${num ?? ''}${space}${one ? unit.one : unit.many}`
  })
}

/**
 * The label to show for one of a template field's select options (display
 * only; the value submitted is the option itself): the field's own
 * `option_labels` slot for the reader's language when the data carries one,
 * else the option with its lakh / crore words localized.
 */
export function rfqOptionLabel(option: string, locale: string, labels?: RfqTemplateField['option_labels']): string {
  const own = locale === 'hi' || locale === 'te' || locale === 'ta' ? labels?.[option]?.[locale] : undefined
  if (own && own.trim()) return own
  return localizeAmountWords(option, locale)
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
