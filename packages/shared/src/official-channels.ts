/**
 * Official AMClub channels (WhatsApp readiness audit 2026-09-26 §5 item 8; ADR-030 §1, D-WA4 "one official number
 * shown everywhere"). The ONE place for the contact facts every surface shows: web help, grievance, account-suspended,
 * the WhatsApp safety page, the WhatsApp settings, and the mobile Help screen.
 *
 * The rule: the official WhatsApp number is the Cloud API business number from env (NEXT_PUBLIC_WHATSAPP_NUMBER on
 * web, EXPO_PUBLIC_WHATSAPP_NUMBER on mobile). Only while that is unset do surfaces fall back to the company line, so
 * the app never shows two different WhatsApp numbers at once. Links we send go only to OFFICIAL_WEB_DOMAIN.
 *
 * Grievance officer facts: DRAFT FOR COUNSEL REVIEW — supplied by the founder on 2026-08-28 (IT Intermediary Rules 2021
 * r.3(2); Consumer Protection (E-Commerce) Rules 2020 r.4(4)–(5)). Pure; no runtime deps.
 */

/** The domain every link we send goes to (the safety page tells people to check for it). */
export const OFFICIAL_WEB_DOMAIN = 'amclub.in'
/** The business display name on WhatsApp. */
export const OFFICIAL_WHATSAPP_DISPLAY_NAME = 'AMClub'

/** The company line: the grievance officer's phone, and the WhatsApp number while the business number is unset. */
export const COMPANY_LINE = { display: '+91 83411 15455', e164: '+918341115455' } as const

export const SUPPORT_EMAIL = 'support@amclub.in'

export const GRIEVANCE_OFFICER = {
  name: 'Sandesh Reddy',
  designation: 'Grievance Officer',
  organisation: 'AMC — All India MSME Club',
  addressLines: ['Flat 205, Pegasus Meenakshi', 'Hyderabad, Telangana 500084'] as const,
  /** The company line (a phone; the WhatsApp number is `officialWhatsApp()`). */
  phone: COMPANY_LINE.display,
  phoneE164: COMPANY_LINE.e164,
  email: 'grievance@amclub.in',
} as const

/** Service commitments — every surface must quote exactly these. */
export const GRIEVANCE_SLA = {
  acknowledgeHours: 24,
  resolveDays: 15,
} as const

/** What AMClub never asks for in a message (the safety page and the mobile Help list these, in this order). */
export const NEVER_ASKED_FOR = ['otp', 'upi_pin', 'card', 'personal_upi'] as const
export type NeverAskedFor = (typeof NEVER_ASKED_FOR)[number]

/**
 * A WhatsApp number as E.164 digits without the plus ("918341115455"), or null when it is not a usable number.
 * Accepts "+91 83411 15455", "91-83411-15455", "0083411…", a bare 10-digit Indian mobile (6–9 first; gets 91) and a
 * trunk-prefixed one ("08341115455").
 */
export function normalizeWhatsAppNumber(raw: string | null | undefined): string | null {
  let d = String(raw ?? '').trim().replace(/[\s\-().]/g, '')
  if (!d) return null
  if (d.startsWith('+')) d = d.slice(1)
  else if (d.startsWith('00')) d = d.slice(2)
  if (!/^\d+$/.test(d)) return null
  if (/^0[6-9]\d{9}$/.test(d)) d = d.slice(1)
  if (/^[6-9]\d{9}$/.test(d)) d = `91${d}`
  return /^[1-9]\d{7,14}$/.test(d) ? d : null
}

/** "+91 83411 15455" for an Indian mobile, "+<digits>" for anything else; '' when the input is not a number. */
export function formatWhatsAppNumber(raw: string | null | undefined): string {
  const d = normalizeWhatsAppNumber(raw)
  if (!d) return ''
  if (/^91[6-9]\d{9}$/.test(d)) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`
  return `+${d}`
}

export interface OfficialWhatsApp {
  /** E.164 digits without the plus, for wa.me. */
  digits: string
  e164: string
  /** Formatted for people: "+91 83411 15455". */
  display: string
  displayName: string
  /** 'env' = the configured business number; 'company_line' = the fallback while it is unset. */
  source: 'env' | 'company_line'
}

/** THE official WhatsApp number for a surface: the configured business number, else the company line. */
export function officialWhatsApp(configured: string | null | undefined): OfficialWhatsApp {
  const fromEnv = normalizeWhatsAppNumber(configured)
  const digits = fromEnv ?? COMPANY_LINE.e164.slice(1)
  return {
    digits,
    e164: `+${digits}`,
    display: formatWhatsAppNumber(digits),
    displayName: OFFICIAL_WHATSAPP_DISPLAY_NAME,
    source: fromEnv ? 'env' : 'company_line',
  }
}

/** A wa.me link to a number (any format normalizeWhatsAppNumber accepts), with optional prefilled text. */
export function waMeHref(number: string, text?: string): string {
  const digits = normalizeWhatsAppNumber(number) ?? String(number).replace(/\D/g, '')
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`
}

/**
 * The link rule the safety page states: a link from AMClub is https and on our domain or one of its subdomains.
 * Parsed by hand (no URL global), so it runs the same on the web, in Node and in React Native.
 */
export function isOfficialLink(url: string | null | undefined): boolean {
  const m = /^https:\/\/([^/?#]*)(?:[/?#]|$)/i.exec(String(url ?? '').trim())
  if (!m) return false
  const authority = m[1]!
  if (authority.includes('@') || authority.includes('\\')) return false
  const host = authority.replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase()
  return host === OFFICIAL_WEB_DOMAIN || host.endsWith(`.${OFFICIAL_WEB_DOMAIN}`)
}
