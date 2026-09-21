import { INDIAN_STATES, onboardingCategoryName, type CategorySlug, type OnboardingAnswer, type OnboardingLocale } from '@amclub/shared'
import { envelope } from '../untrusted/envelope'
import type { ChatParts } from '../llm/gateway'

/**
 * Prompt parts for `onboarding_interview@v1` (S1.6). Every provider utterance
 * — each capability answer, each transcript, each revise note — enters ONLY
 * as an Envelope (`onboarding_answer`, id = the wa_messages row). The trusted
 * block carries what the platform owns: the locale, the chosen categories
 * with their English names, the listing template in words, an answer map
 * (which envelope answers which question) and the provider's stated business
 * name / state ONLY after Zod-style cleaning — anything that fails the clean
 * goes into an envelope instead. A unit test asserts no answer text ever
 * appears in `trusted`.
 */

export interface OnboardingPartsInput {
  sessionId: string
  locale: OnboardingLocale
  categorySlugs: CategorySlug[]
  /** The raw business-name answer (cleaned here; falls back to untrusted). */
  businessName: string | null
  /** The GSTIN the provider typed (format-checked by the machine); its first two digits name the state. */
  gstin: string | null
  /** Capability answers and revise notes, in order. */
  answers: Pick<OnboardingAnswer, 'wa_message_id' | 'text' | 'step' | 'category_slug' | 'question_no' | 'kind'>[]
}

/** GST state codes (first two GSTIN digits) → the platform's 2-letter codes (INDIAN_STATES). */
export const GST_STATE_CODES: Record<string, string> = {
  '01': 'JK', '02': 'HP', '03': 'PB', '04': 'CH', '05': 'UK', '06': 'HR', '07': 'DL', '08': 'RJ', '09': 'UP', '10': 'BR',
  '11': 'SK', '12': 'AR', '13': 'NL', '14': 'MN', '15': 'MZ', '16': 'TR', '17': 'ML', '18': 'AS', '19': 'WB', '20': 'JH',
  '21': 'OD', '22': 'CG', '23': 'MP', '24': 'GJ', '26': 'DN', '27': 'MH', '29': 'KA', '30': 'GA', '31': 'LD', '32': 'KL',
  '33': 'TN', '34': 'PY', '35': 'AN', '36': 'TS', '37': 'AP', '38': 'LA',
}

export function stateFromGstin(gstin: string | null | undefined): string | null {
  if (!gstin || gstin.length < 2) return null
  const code = GST_STATE_CODES[gstin.slice(0, 2)]
  return code && INDIAN_STATES.some((s) => s.value === code) ? code : null
}

// Letters, digits, spaces and a few name punctuation marks; no brackets, colons, newlines, quotes.
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,&'()\-]{1,99}$/u

/** A business name is trusted only when it is a plain short name; otherwise it goes untrusted. */
export function cleanBusinessName(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().replace(/\s+/g, ' ')
  if (!v || v.length > 100 || !NAME_RE.test(v)) return null
  if (/ignore|instruction|system|verified|approve|admin|<|>|\{|\}/i.test(v)) return null
  return v
}

export function buildOnboardingParts(input: OnboardingPartsInput): ChatParts {
  const name = cleanBusinessName(input.businessName)
  const state = stateFromGstin(input.gstin)
  const trusted = [
    `locale: ${input.locale}`,
    `categories: ${input.categorySlugs.map((s) => `${s} ("${onboardingCategoryName(s, 'en')}")`).join('; ') || 'none'}`,
    'listing_fields: category_slug (one of the categories above); title (5..200 chars); scope_included (1..8 short lines); deliverables (1..8 short lines); price_paise (integer paise, null unless the provider stated an amount); delivery_days (1..365, null unless stated)',
    `business_name: ${name ?? 'see untrusted (not clean)'}`,
    `state: ${state ?? 'not stated'}`,
    `answer_map: ${input.answers.map((a) => `${a.wa_message_id}=${a.step === 'capabilities' ? `${a.category_slug ?? '?'}#${a.question_no ?? '?'}` : a.step === 'review' ? 'revise_note' : a.step}`).join('; ') || 'none'}`,
  ]
  const untrusted = input.answers.map((a) => envelope(a.text, { kind: 'onboarding_answer', id: a.wa_message_id }))
  if (!name && input.businessName && input.businessName.trim()) {
    untrusted.unshift(envelope(input.businessName, { kind: 'onboarding_business_name', id: input.sessionId }))
  }
  return { trusted, untrusted }
}
