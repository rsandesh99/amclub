import { z } from 'zod'

/**
 * WhatsApp channel contract (ADR-030, PRD_WHATSAPP). One place for the vocabulary every surface shares: the
 * template locales, consent purposes and sources, suppression reasons, template categories, and the ONE keyword
 * classifier the runtime dispatcher uses. Pure; no runtime deps beyond zod.
 *
 * Consent belongs to a PHONE and a PURPOSE (DPDP s.6: specific purpose; Meta: opt-in before any business-initiated
 * message). It is separate from agent delegation (agent_grants), which says what an agent may do for the user.
 */

/** Template / reply locales. ta has its own templates (audit B2); a locale without a template variant falls back to en
 *  AND is sent with the en language code — never an en name under another language code. */
export const WA_LOCALES = ['en', 'hi', 'te', 'ta'] as const
export type WaLocale = (typeof WA_LOCALES)[number]
export function waLocaleFor(preferred: string | null | undefined): WaLocale {
  return (WA_LOCALES as readonly string[]).includes(preferred ?? '') ? (preferred as WaLocale) : 'en'
}

/** What a phone agreed to receive. transactional = order / request / payment updates; assistant = the AMClub assistant
 *  writing first (drafts, reminders it raises); marketing = offers and product news (never without its own opt-in). */
export const WA_CONSENT_PURPOSES = ['transactional', 'assistant', 'marketing'] as const
export type WaConsentPurpose = (typeof WA_CONSENT_PURPOSES)[number]

export const WA_CONSENT_ACTIONS = ['opt_in', 'opt_out'] as const
export type WaConsentAction = (typeof WA_CONSENT_ACTIONS)[number]

/** Where a consent event came from. Stored on every wa_consent_events row. */
export const WA_CONSENT_SOURCES = [
  'whatsapp_keyword', 'whatsapp_button', 'web_settings', 'mobile_settings', 'signup', 'checkout', 'ctwa', 'admin', 'system',
] as const
export type WaConsentSource = (typeof WA_CONSENT_SOURCES)[number]

/** Sources a signed-in user's own request may claim (the WhatsApp ones are recorded only by the runtime). */
export const WA_CLIENT_CONSENT_SOURCES = ['web_settings', 'mobile_settings', 'signup', 'checkout'] as const

/** Delivery-driven suppression (Meta sends no "blocked" event; these come from error codes). STOP is not here: it is an
 *  opt_out consent event for every purpose. */
export const WA_SUPPRESSION_REASONS = ['not_on_whatsapp', 'marketing_stopped', 'undeliverable', 'blocked', 'admin'] as const
export type WaSuppressionReason = (typeof WA_SUPPRESSION_REASONS)[number]

export const WA_TEMPLATE_CATEGORIES = ['utility', 'marketing', 'authentication'] as const
export type WaTemplateCategory = (typeof WA_TEMPLATE_CATEGORIES)[number]

/** The notice a consent refers to. Bump when the opt-in wording (whatsapp.notice_* in messages, the opt-in template)
 *  changes; the version is stored on every consent event so the exact notice can be proven later (DPDP s.6(10)). */
export const WA_NOTICE_VERSION = 'wa-2026-09-26'

export const waConsentUpdateSchema = z.object({
  purpose: z.enum(WA_CONSENT_PURPOSES),
  optIn: z.boolean(),
  source: z.enum(WA_CLIENT_CONSENT_SOURCES),
  noticeVersion: z.string().min(1).max(40),
})
export type WaConsentUpdate = z.infer<typeof waConsentUpdateSchema>

export type WaConsentStatus = 'opted_in' | 'opted_out' | 'none'
export interface WaConsentState {
  /** The account's phone, masked except the last four digits; null when the account has no phone. */
  phoneMasked: string | null
  purposes: Record<WaConsentPurpose, WaConsentStatus>
  /** Delivery-driven suppression on this phone (e.g. not on WhatsApp). */
  suppressed: WaSuppressionReason | null
  noticeVersion: string
  /** The official AMClub WhatsApp number (E.164 digits) for wa.me links; null when not configured. */
  businessNumber: string | null
}

// ── Keywords ─────────────────────────────────────────────────────────────────
// Audit B4: a greeting is not consent, and "no" / "cancel" are not a global opt-out. Opt-in is START (or a button);
// opt-out is STOP / UNSUBSCRIBE and their hi / te / ta forms, tolerant of punctuation and a "please". Everything the
// runtime answers without a model (HELP menu, language switch, report, data requests) is classified here too.

export type WaKeywordIntent =
  | 'stop' | 'start' | 'help' | 'language' | 'report' | 'my_data' | 'delete_data' | 'join' | 'greeting'

export interface WaKeyword {
  intent: WaKeywordIntent
  /** For `language`: the locale the user asked for (null = show the language list). */
  locale?: WaLocale | null
}

const STOP = ['stop', 'unsubscribe', 'stop all', 'opt out', 'optout', 'बंद', 'बंद करो', 'बंद करें', 'रोकें', 'रोको', 'ఆపు', 'ఆపండి', 'நிறுத்து', 'நிறுத்துங்கள்']
const START = ['start', 'subscribe', 'opt in', 'optin', 'शुरू', 'शुरू करें', 'ప్రారంభం', 'ప్రారంభించు', 'தொடங்கு']
const HELP = ['help', 'menu', '?', 'मदद', 'मेनू', 'సహాయం', 'మెనూ', 'உதவி', 'மெனு']
const REPORT = ['report', 'report spam', 'spam', 'शिकायत', 'ఫిర్యాదు', 'புகார்']
const MY_DATA = ['my data', 'mydata', 'मेरा डेटा', 'నా డేటా', 'என் தரவு']
const DELETE_DATA = ['delete my data', 'delete data', 'erase my data', 'मेरा डेटा हटाओ', 'నా డేటా తొలగించు', 'என் தரவை நீக்கு']
const JOIN = ['join', 'onboard', 'जुड़ें', 'చేరండి', 'சேர்']
const GREETING = ['hi', 'hello', 'hey', 'hii', 'namaste', 'namaskar', 'ok', 'okay', 'yes', 'नमस्ते', 'हाँ', 'हां', 'నమస్తే', 'నమస్కారం', 'అవును', 'வணக்கம்', 'ஆம்']
const LANGUAGE_WORDS = ['language', 'lang', 'भाषा', 'భాష', 'மொழி']
const LANGUAGE_NAMES: Record<string, WaLocale> = {
  english: 'en', 'अंग्रेज़ी': 'en', 'अंग्रेजी': 'en',
  hindi: 'hi', 'हिंदी': 'hi', 'हिन्दी': 'hi',
  telugu: 'te', 'తెలుగు': 'te',
  tamil: 'ta', 'தமிழ்': 'ta',
}
const POLITE = ['please', 'pls', 'plz', 'kindly', 'कृपया', 'దయచేసి', 'தயவுசெய்து']

/** Lower-case, NFKC, strip surrounding punctuation / emoji, collapse spaces, drop a leading or trailing "please". */
export function normalizeWaKeyword(text: string | null | undefined): string {
  if (!text) return ''
  let t = text.normalize('NFKC').toLowerCase().trim()
  // punctuation and symbols at either end (keeps a lone "?" — it is the HELP key)
  if (t !== '?') t = t.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')
  t = t.replace(/\s+/g, ' ')
  const words = t.split(' ')
  while (words.length > 1 && POLITE.includes(words[0]!)) words.shift()
  while (words.length > 1 && POLITE.includes(words[words.length - 1]!)) words.pop()
  return words.join(' ')
}

/**
 * The runtime's keyword classifier. Only whole-message matches count (a sentence that merely contains "stop" is not an
 * opt-out); a message of more than four words is never a keyword. A button's payload is classified by the caller, not
 * here — its visible title never is.
 */
export function classifyWaKeyword(text: string | null | undefined): WaKeyword | null {
  const t = normalizeWaKeyword(text)
  if (!t || t.split(' ').length > 4) return null
  if (STOP.includes(t)) return { intent: 'stop' }
  if (START.includes(t)) return { intent: 'start' }
  if (DELETE_DATA.includes(t)) return { intent: 'delete_data' }
  if (MY_DATA.includes(t)) return { intent: 'my_data' }
  if (HELP.includes(t)) return { intent: 'help' }
  if (REPORT.includes(t)) return { intent: 'report' }
  if (JOIN.includes(t)) return { intent: 'join' }
  if (LANGUAGE_WORDS.includes(t)) return { intent: 'language', locale: null }
  const named = LANGUAGE_NAMES[t]
  if (named) return { intent: 'language', locale: named }
  if (GREETING.includes(t)) return { intent: 'greeting' }
  return null
}

/** Mask a phone for display: keep the last four digits. */
export function maskWaPhone(phone: string | null | undefined): string | null {
  const d = String(phone ?? '').replace(/\D/g, '')
  if (!d) return null
  return `${'•'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}`
}

/** A Meta `from` is an E.164 phone only when it is all digits (8–15). A business-scoped user id ("IN.xxxx…") is not a
 *  phone and must never be reduced to its digits (audit 2.9). */
export function waPhoneFromVendor(from: string | null | undefined): string | null {
  const s = String(from ?? '').trim().replace(/^\+/, '')
  return /^\d{8,15}$/.test(s) ? s : null
}

// ── Secrets typed into chat ──────────────────────────────────────────────────
// A user sometimes pastes an OTP, a UPI PIN or a card number into WhatsApp. Stored text never keeps them: the webhook
// stores the redacted body and the job warns the user (never ask for these; the "official AMClub" page says so).
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g
const SECRET_CONTEXT_RE = /\b(otp|one[- ]time|pin|upi pin|mpin|cvv|cvc|password|passcode)\b[^\d]{0,20}(\d{3,8})\b/gi
function luhnOk(digits: string): boolean {
  let sum = 0
  let dbl = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (dbl) { d *= 2; if (d > 9) d -= 9 }
    sum += d
    dbl = !dbl
  }
  return sum % 10 === 0
}
export interface ChatRedaction { text: string; redacted: Array<'card' | 'secret_code'> }
/** Replace card numbers (Luhn-valid, 13–19 digits) and codes next to OTP / PIN / CVV / password words with [removed]. */
export function redactChatSecrets(text: string | null | undefined): ChatRedaction {
  const kinds = new Set<'card' | 'secret_code'>()
  let out = String(text ?? '')
  out = out.replace(CARD_RE, (m) => {
    const d = m.replace(/\D/g, '')
    if (d.length >= 13 && d.length <= 19 && luhnOk(d)) { kinds.add('card'); return '[removed]' }
    return m
  })
  out = out.replace(SECRET_CONTEXT_RE, (m, word: string) => { kinds.add('secret_code'); return `${word} [removed]` })
  return { text: out, redacted: [...kinds] }
}
