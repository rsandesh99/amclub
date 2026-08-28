/**
 * Grievance Officer + support contact — the ONE place these facts live.
 * Rendered by <GrievanceOfficerBlock /> on /grievance and /terms, and used by
 * /help. Change the address/phone here and every surface follows.
 *
 * Statutory basis: IT (Intermediary Guidelines) Rules 2021 r.3(2) and the
 * Consumer Protection (E-Commerce) Rules 2020 r.4(4)–(5) require a named
 * officer with contact details, acknowledgement within 24 h and redressal
 * within 15 days (the stricter of the two regimes on each measure).
 *
 * DRAFT FOR COUNSEL REVIEW — facts supplied by the founder on 2026-08-28.
 */
export const GRIEVANCE_OFFICER = {
  name: 'Sandesh Reddy',
  designation: 'Grievance Officer',
  organisation: 'AMC — All India MSME Club',
  addressLines: ['Flat 205, Pegasus Meenakshi', 'Hyderabad, Telangana 500084'] as const,
  /** Company line — also the support WhatsApp number. */
  phone: '+91 83411 15455',
  phoneE164: '+918341115455',
  email: 'grievance@amclub.in',
} as const

export const SUPPORT_CONTACT = {
  email: 'support@amclub.in',
  whatsapp: GRIEVANCE_OFFICER.phone,
  whatsappE164: GRIEVANCE_OFFICER.phoneE164,
} as const

/** Service commitments — every surface must quote exactly these. */
export const GRIEVANCE_SLA = {
  acknowledgeHours: 24,
  resolveDays: 15,
} as const

export const whatsappHref = (e164: string, text?: string) =>
  `https://wa.me/${e164.replace(/[^0-9]/g, '')}${text ? `?text=${encodeURIComponent(text)}` : ''}`
