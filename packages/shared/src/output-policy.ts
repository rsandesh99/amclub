import { COMPARE_BANNED_PHRASES } from './compare-pointers'

/**
 * S2.1 — the customer-facing output policy (lists and patterns only; the Zod
 * post-validator that applies them lives in @amclub/agent-core
 * `untrusted/output.ts`). Every prompt whose text reaches a buyer, provider or
 * WhatsApp user is post-validated against these: no contact details, no
 * off-platform payment instruction, no ranking / approval language where
 * forbidden, no URLs. A violation REJECTS the model output so the caller falls
 * back (template message, rule-only report, chips dropped) — never leaks.
 *
 * `redactContactInfo` (rfq.ts) stays the storage-time masker; this file is the
 * output-time refuser. Lists are lowercase-matched; English words are checked
 * in every locale because they leak into Hindi / Tamil / Telugu output.
 */

export type OutputLocale = 'en' | 'hi' | 'ta' | 'te'
export const OUTPUT_LOCALES = ['en', 'hi', 'ta', 'te'] as const

export const OFF_PLATFORM_PAYMENT_PHRASES: Record<OutputLocale, readonly string[]> = {
  en: [
    'upi', 'gpay', 'google pay', 'phonepe', 'phone pe', 'paytm', 'pay directly', 'pay me directly', 'pay us directly',
    'pay in cash', 'cash only', 'cash payment only', 'outside the app', 'outside the platform', 'outside amclub',
    'off-platform', 'off platform', 'my account number', 'our account number', 'bank transfer to my', 'transfer to my account',
    'ifsc', 'my bank details', 'send the advance to my', 'bypass the platform', 'skip the platform',
    // Hinglish
    'seedha payment', 'seedhe payment', 'mujhe direct', 'app ke bahar', 'platform ke bahar', 'mera upi', 'mere account mein',
  ],
  hi: [
    'यूपीआई', 'गूगल पे', 'फोनपे', 'फोन पे', 'पेटीएम', 'सीधे भुगतान', 'सीधे पैसे', 'सीधा भुगतान', 'ऐप के बाहर', 'एप के बाहर',
    'प्लेटफ़ॉर्म के बाहर', 'प्लेटफॉर्म के बाहर', 'मेरा खाता नंबर', 'मेरे खाते में', 'हमारे खाते में', 'बैंक ट्रांसफर मेरे',
    'सिर्फ नकद', 'केवल नकद', 'नकद में भुगतान', 'आईएफएससी',
  ],
  ta: [
    'யூபிஐ', 'கூகுள் பே', 'போன்பே', 'போன் பே', 'பேடிஎம்', 'நேரடியாக பணம்', 'நேரடியாக செலுத்த', 'ஆப்பிற்கு வெளியே',
    'செயலிக்கு வெளியே', 'தளத்திற்கு வெளியே', 'என் கணக்கு எண்', 'என் கணக்கிற்கு', 'எங்கள் கணக்கிற்கு', 'ரொக்கமாக மட்டும்',
    'ரொக்கம் மட்டும்', 'ஐஎஃப்எஸ்சி',
  ],
  te: [
    'యూపీఐ', 'గూగుల్ పే', 'ఫోన్‌పే', 'ఫోన్ పే', 'పేటీఎం', 'నేరుగా చెల్లించ', 'నేరుగా డబ్బు', 'యాప్ బయట', 'యాప్ వెలుపల',
    'ప్లాట్‌ఫారమ్ బయట', 'నా ఖాతా నంబర్', 'నా ఖాతాకు', 'మా ఖాతాకు', 'నగదు మాత్రమే', 'కేవలం నగదు', 'ఐఎఫ్ఎస్‌సీ',
  ],
}

/** Ranking / steering language (the S1.2 compare list, re-exported so one list rules every customer-facing surface). */
export const RANKING_PHRASES: Record<OutputLocale, readonly string[]> = COMPARE_BANNED_PHRASES

/** Approval / verification / release claims a model must never make to a customer. */
export const APPROVAL_PHRASES: Record<OutputLocale, readonly string[]> = {
  en: ['approved', 'is verified', 'now verified', 'kyc verified', 'verification complete', 'release the payout', 'payout released', 'payout is released', 'refund granted', 'refund approved', 'refund is approved', 'dispute resolved in your favour', 'dispute resolved in your favor', 'we have released', 'has been approved'],
  hi: ['मंज़ूर', 'मंजूर', 'स्वीकृत', 'सत्यापित', 'वेरिफाइड', 'रिफंड मंज़ूर', 'रिफंड मंजूर', 'भुगतान जारी', 'पेआउट जारी', 'भुगतान रिलीज़'],
  ta: ['அங்கீகரிக்கப்பட்ட', 'அங்கீகரிக்கப்பட்டது', 'சரிபார்க்கப்பட்ட', 'சரிபார்க்கப்பட்டது', 'ரீஃபண்ட் வழங்க', 'பணம் விடுவிக்கப்பட்டது'],
  te: ['ఆమోదించబడింది', 'ఆమోదించాము', 'ధృవీకరించబడింది', 'ధృవీకరించాము', 'రీఫండ్ మంజూరు', 'చెల్లింపు విడుదల'],
}

/** Contact and identity patterns. Text is Indic-digit-folded before matching (see `foldOutputDigits`). */
export const CONTACT_PATTERNS: Readonly<Record<'phone' | 'email' | 'upi' | 'url' | 'handle' | 'gstin' | 'pan', RegExp>> = {
  // Indian mobile: optional +91 / 0, then a 10-digit number starting 6–9, digits possibly separated by spaces / dashes / dots.
  phone: /(?:\+?91[\s.-]?|\b0)?[6-9](?:[\s.-]?\d){9}\b/,
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  // UPI VPA name@bank (known handles + generic short bank codes).
  upi: /\b[A-Za-z0-9._-]{2,}@(?:ybl|okaxis|oksbi|okicici|okhdfcbank|paytm|upi|ibl|axl|apl|axisbank|icici|hdfcbank|sbi|kotak|yesbank|ptyes|ptaxis|ptsbi|fbl|jio|airtel|waicici|wahdfcbank|wasbi|waaxis)\b/i,
  url: /\bhttps?:\/\/\S+|\bwww\.[A-Za-z0-9-]+\.[A-Za-z]{2,}\S*|\b[A-Za-z0-9-]+\.(?:com|in|co\.in|org|net|io|app|me|xyz|shop|site|store|online)\b(?:\/\S*)?/i,
  // WhatsApp / Telegram handles and "whatsapp me on".
  handle: /(?:\bt\.me\/\S+|\btelegram\s*[:@]\s*\S+|\bwhatsapp\s*(?:me\s*)?(?:on|at|number|no\.?)\s*[:+\d]|\b@[A-Za-z0-9_]{5,}\b(?!\.))/i,
  gstin: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/,
  pan: /\b[A-Z]{5}\d{4}[A-Z]\b/,
}

export type OutputForbid = 'contact' | 'payment' | 'ranking' | 'approval' | 'urls'
export type OutputViolationCode = 'contact_info' | 'off_platform_payment' | 'ranking_language' | 'approval_language' | 'url'

export interface OutputViolation {
  code: OutputViolationCode
  match: string
}

const INDIC_DIGIT_BLOCKS = [0x0966, 0x0c66, 0x0be6, 0x09e6, 0x0ae6]
export function foldOutputDigits(s: string): string {
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    let mapped: string | null = null
    for (const base of INDIC_DIGIT_BLOCKS) if (cp >= base && cp <= base + 9) { mapped = String(cp - base); break }
    out += mapped ?? ch
  }
  return out
}

export function toOutputLocale(locale: string | null | undefined): OutputLocale {
  const base = (locale ?? 'en').toLowerCase().split('-')[0]
  return base === 'hi' || base === 'ta' || base === 'te' ? base : 'en'
}

function phraseHits(text: string, lists: Record<OutputLocale, readonly string[]>, locale: OutputLocale): string[] {
  const hay = text.toLowerCase()
  const candidates = locale === 'en' ? lists.en : [...lists[locale], ...lists.en]
  return candidates.filter((p) => hay.includes(p.toLowerCase()))
}

/**
 * Every violation in one string. `contact` covers phone / email / UPI VPA /
 * handles / full GSTIN / PAN (masked forms like XXXXXXXXXXXA1Z5 pass); `urls`
 * covers links; `payment`, `ranking`, `approval` are per-locale phrase lists
 * (English always included).
 */
export function findOutputViolations(text: string, opts: { locale?: string | null; forbid: readonly OutputForbid[] }): OutputViolation[] {
  const out: OutputViolation[] = []
  const t = foldOutputDigits(text ?? '').normalize('NFKC')
  const locale = toOutputLocale(opts.locale)
  const forbid = new Set(opts.forbid)
  if (forbid.has('contact')) {
    for (const key of ['phone', 'email', 'upi', 'handle', 'gstin', 'pan'] as const) {
      const m = CONTACT_PATTERNS[key].exec(t)
      if (m) out.push({ code: 'contact_info', match: m[0] })
    }
  }
  if (forbid.has('urls')) {
    const m = CONTACT_PATTERNS.url.exec(t)
    if (m) out.push({ code: 'url', match: m[0] })
  }
  if (forbid.has('payment')) for (const p of phraseHits(t, OFF_PLATFORM_PAYMENT_PHRASES, locale)) out.push({ code: 'off_platform_payment', match: p })
  if (forbid.has('ranking')) for (const p of phraseHits(t, RANKING_PHRASES, locale)) out.push({ code: 'ranking_language', match: p })
  if (forbid.has('approval')) for (const p of phraseHits(t, APPROVAL_PHRASES, locale)) out.push({ code: 'approval_language', match: p })
  return out
}
