import { WA_LOCALES, type WaLocale } from '@amclub/shared'
import type { WaTemplateSpec, WaTemplateValues } from './template-types'

/**
 * Building blocks for the WhatsApp template registries (templates.ts, templates-notify.ts, templates-system.ts).
 * Kept apart from templates.ts so the registry files can import them without an import cycle (templates.ts imports
 * the other two registries). Telugu and Tamil strings are machine drafts: native review pending.
 */

export type L = Record<WaLocale, string>
export const ALL: readonly WaLocale[] = WA_LOCALES
export const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

/** Meta language codes for the submitted variants. */
export const WA_TEMPLATE_LANGUAGE: Record<WaLocale, string> = { en: 'en', hi: 'hi', te: 'te', ta: 'ta' }

/** The fixed prefix every URL button is approved with; only the suffix after it is dynamic. */
export const WA_URL_BUTTON_BASE = 'https://amclub.in/'
/** Where a URL button goes when the send carries no link (every account has the buyer app). */
export const WA_DEFAULT_LINK_SUFFIX = 'app/notifications'

/**
 * A notification link (app-relative `/app/orders/…`, or absolute on our domain) → the URL-button suffix. Only the
 * path and query are kept: the approved prefix is our domain, so a button can never point anywhere else.
 */
export function linkSuffix(link: string | null | undefined, fallback: string = WA_DEFAULT_LINK_SUFFIX): string {
  const raw = s(link).trim()
  if (!raw) return fallback
  let path = raw
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      path = `${u.pathname}${u.search}`
    } catch {
      return fallback
    }
  }
  const out = path.replace(/^\/+/, '').replace(/\s+/g, '%20')
  return out || fallback
}

// ── shared copy ──────────────────────────────────────────────────────────────

export const UPDATE: L = { en: 'Update', hi: 'अपडेट', te: 'అప్‌డేట్', ta: 'புதுப்பிப்பு' }
export const DETAILS: L = { en: 'Details', hi: 'विवरण', te: 'వివరాలు', ta: 'விவரங்கள்' }

export const TAIL_ORDER: L = {
  en: 'Tap the button below to open the order.',
  hi: 'ऑर्डर खोलने के लिए नीचे दिया बटन दबाएँ।',
  te: 'ఆర్డర్‌ను తెరవడానికి కింది బటన్‌ను నొక్కండి.',
  ta: 'ஆர்டரைத் திறக்க கீழே உள்ள பொத்தானைத் தட்டவும்.',
}
export const TAIL_REQUEST: L = {
  en: 'Tap the button below to open the request.',
  hi: 'रिक्वेस्ट खोलने के लिए नीचे दिया बटन दबाएँ।',
  te: 'రిక్వెస్ట్‌ను తెరవడానికి కింది బటన్‌ను నొక్కండి.',
  ta: 'கோரிக்கையைத் திறக்க கீழே உள்ள பொத்தானைத் தட்டவும்.',
}
export const TAIL_DETAILS: L = {
  en: 'Tap the button below for the details.',
  hi: 'विवरण के लिए नीचे दिया बटन दबाएँ।',
  te: 'వివరాల కోసం కింది బటన్‌ను నొక్కండి.',
  ta: 'விவரங்களுக்கு கீழே உள்ள பொத்தானைத் தட்டவும்.',
}

export const BTN_ORDER: L = { en: 'View order', hi: 'ऑर्डर देखें', te: 'ఆర్డర్ చూడండి', ta: 'ஆர்டரைப் பார்க்க' }
export const BTN_REQUEST: L = { en: 'View request', hi: 'रिक्वेस्ट देखें', te: 'రిక్వెస్ట్ చూడండి', ta: 'கோரிக்கையைப் பார்க்க' }
export const BTN_DETAILS: L = { en: 'View details', hi: 'विवरण देखें', te: 'వివరాలు చూడండి', ta: 'விவரங்களைப் பார்க்க' }
export const BTN_ASSISTANT: L = { en: 'Open assistant', hi: 'असिस्टेंट खोलें', te: 'అసిస్టెంట్ తెరవండి', ta: 'உதவியாளரைத் திறக்க' }
export const BTN_CONTINUE: L = { en: 'Continue', hi: 'जारी रखें', te: 'కొనసాగించండి', ta: 'தொடரவும்' }
export const BTN_APPLICATION: L = { en: 'Open application', hi: 'आवेदन खोलें', te: 'దరఖాస్తు తెరవండి', ta: 'விண்ணப்பத்தைத் திறக்க' }

export const EX_ORDER = { title: 'Order AMC-2417 accepted', body: 'Lakshmi Tax Services accepted your GST filing order.', link: '/app/orders/9d1c2f0e' }
export const EX_PROVIDER_ORDER = { title: 'New order AMC-2417', body: 'GST return filing for Ravi Traders, due in 5 days.', link: '/partner/orders/9d1c2f0e' }
export const EX_RFQ = { title: 'GST registration for a new shop', body: 'Hyderabad, needed within 7 days.', link: '/app/rfq/4b7e11aa' }
export const EX_PROVIDER_RFQ = { title: 'GST registration for a new shop', body: 'Hyderabad, needed within 7 days.', link: '/partner/rfqs/4b7e11aa' }

export function urlButton(label: L, fallback: string = WA_DEFAULT_LINK_SUFFIX): NonNullable<WaTemplateSpec['urlButton']> {
  return { label, suffix: (v) => linkSuffix(v['link'], fallback) }
}

/**
 * A notification template carrying the notification's localized title and body (values `title`, `body`, `link`):
 * "<lead>\n\nUpdate: {{1}}\nDetails: {{2}}\n\n<tail>" and a URL button to the notification's screen.
 */
export function notice(stem: string, lead: L, tail: L, button: L, example: WaTemplateValues): WaTemplateSpec {
  const body = {} as L
  for (const l of ALL) body[l] = `${lead[l]}\n\n${UPDATE[l]}: {{1}}\n${DETAILS[l]}: {{2}}\n\n${tail[l]}`
  return { stem, category: 'utility', locales: ALL, body, params: (v) => [s(v['title']), s(v['body'])], urlButton: urlButton(button), example }
}

/** A template whose body is written per locale; `params` names the values in order. */
export function fixed(stem: string, body: L, params: readonly string[], example: WaTemplateValues, button?: WaTemplateSpec['urlButton']): WaTemplateSpec {
  return { stem, category: 'utility', locales: ALL, body, params: (v) => params.map((k) => s(v[k])), ...(button ? { urlButton: button } : {}), example }
}

