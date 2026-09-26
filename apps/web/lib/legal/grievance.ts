import {
  GRIEVANCE_OFFICER as OFFICER,
  GRIEVANCE_SLA as SLA,
  SUPPORT_EMAIL,
  officialWhatsApp,
  waMeHref,
} from '@amclub/shared'

/**
 * Grievance Officer + support contact for the web. The facts themselves live in
 * `@amclub/shared` official-channels (one source for web and mobile); this file
 * binds them to the web's env. Rendered by <GrievanceOfficerBlock /> on
 * /grievance and /terms, and used by /help, /account-suspended, the WhatsApp
 * safety page and the WhatsApp settings.
 *
 * Statutory basis: IT (Intermediary Guidelines) Rules 2021 r.3(2) and the
 * Consumer Protection (E-Commerce) Rules 2020 r.4(4)–(5) require a named
 * officer with contact details, acknowledgement within 24 h and redressal
 * within 15 days (the stricter of the two regimes on each measure).
 *
 * DRAFT FOR COUNSEL REVIEW — facts supplied by the founder on 2026-08-28.
 */
export const GRIEVANCE_OFFICER = OFFICER

/**
 * THE official WhatsApp number (audit §5 item 8): the Cloud API business
 * number (NEXT_PUBLIC_WHATSAPP_NUMBER), or the company line while it is unset —
 * never both at once. Build-time env, so client components may read it.
 */
export const OFFICIAL_WHATSAPP = officialWhatsApp(process.env['NEXT_PUBLIC_WHATSAPP_NUMBER'])

export const SUPPORT_CONTACT = {
  email: SUPPORT_EMAIL,
  whatsapp: OFFICIAL_WHATSAPP.display,
  whatsappE164: OFFICIAL_WHATSAPP.e164,
} as const

/** Service commitments — every surface must quote exactly these. */
export const GRIEVANCE_SLA = SLA

export const whatsappHref = (e164: string, text?: string) => waMeHref(e164, text)
