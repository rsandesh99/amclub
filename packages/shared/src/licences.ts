import { z } from 'zod'
import type { CategorySlug } from './categories'
import { employeeBandSchema, sectorSchema } from './schemas'

/**
 * PRD Experience v3 E9b — FR-9.5 (N45, F7; gated by D-PRD5). Licences a buyer
 * holds, renewal reminders, and the "What do I need?" routing checklist.
 * Dark behind `agent_settings.obligations_enabled` (default off) until counsel
 * and the CA answer D-PRD5 and the checklist reaches ≥ 95 % precision on the
 * CA's 50-profile set. A routing checklist, never advice: no model in v3.
 */

/** The licence kinds v3 knows, each routed to the category (and service) that renews it. */
export const LICENCE_TYPES = {
  fssai: { category: 'company-registrations', service: 'fssai-license', expires: true },
  gst_registration: { category: 'company-registrations', service: 'gst-registration', expires: false },
  udyam: { category: 'company-registrations', service: 'udyam-registration', expires: false },
  iec: { category: 'company-registrations', service: 'iec-code', expires: false },
  factory_licence: { category: 'government-licensing', service: 'factory-license', expires: true },
  pollution_consent: { category: 'government-licensing', service: 'pollution-noc', expires: true },
  fire_noc: { category: 'government-licensing', service: null, expires: true },
  trade_licence: { category: 'government-licensing', service: null, expires: true },
  shops_establishment: { category: 'government-licensing', service: null, expires: true },
  trademark: { category: 'legal', service: 'trademark', expires: true },
  professional_tax: { category: 'tax-accounting', service: null, expires: false },
} as const satisfies Record<string, { category: CategorySlug; service: string | null; expires: boolean }>
export type LicenceType = keyof typeof LICENCE_TYPES
export const LICENCE_TYPE_KEYS = Object.keys(LICENCE_TYPES) as LicenceType[]

export const LICENCE_SOURCES = ['manual', 'order'] as const
export type LicenceSource = (typeof LICENCE_SOURCES)[number]

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** `POST /api/v1/me/licences` — add a licence by hand, or confirm one recorded on a finished order. */
export const licenceCreateSchema = z.union([
  z
    .object({
      licenceType: z.enum(LICENCE_TYPE_KEYS as [LicenceType, ...LicenceType[]]),
      number: z.string().trim().min(1).max(64).optional(),
      issuedOn: isoDate.optional(),
      expiresOn: isoDate.optional(),
      authority: z.string().trim().min(1).max(120).optional(),
    })
    .strict()
    .refine((v) => !v.issuedOn || !v.expiresOn || v.expiresOn >= v.issuedOn, { message: 'expires_before_issued', path: ['expiresOn'] }),
  z.object({ fromOrderId: z.string().uuid() }).strict(),
])
export type LicenceCreateInput = z.infer<typeof licenceCreateSchema>

/** What the provider records on delivering a registration order (FR-9.5 "confirm one from a completed registration order"). */
export const orderLicenceFactsSchema = z
  .object({
    licenceType: z.enum(LICENCE_TYPE_KEYS as [LicenceType, ...LicenceType[]]),
    number: z.string().trim().min(1).max(64),
    issuedOn: isoDate.optional(),
    expiresOn: isoDate.optional(),
    authority: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((v) => !v.issuedOn || !v.expiresOn || v.expiresOn >= v.issuedOn, { message: 'expires_before_issued', path: ['expiresOn'] })
export type OrderLicenceFacts = z.infer<typeof orderLicenceFactsSchema>

export const licenceViewSchema = z.object({
  id: z.string().uuid(),
  licenceType: z.enum(LICENCE_TYPE_KEYS as [LicenceType, ...LicenceType[]]),
  number: z.string().nullable(),
  issuedOn: z.string().nullable(),
  expiresOn: z.string().nullable(),
  authority: z.string().nullable(),
  source: z.enum(LICENCE_SOURCES),
  hasCertificate: z.boolean(),
  /** Days until expiry (IST calendar days; negative = lapsed); null when there is no expiry. */
  daysLeft: z.number().int().nullable(),
  /** Where "Renew" goes: the category (and service) that provides it. */
  renewHref: z.string(),
})
export type LicenceView = z.infer<typeof licenceViewSchema>

/** Private bucket for licence certificates (images / PDFs, 5 MB); owner-only signed reads. */
export const LICENCE_CERT_BUCKET = 'licence-certificates'
export const LICENCE_CERT_MAX_BYTES = 5 * 1024 * 1024

// ── Reminders ────────────────────────────────────────────────────────────────
/** Days before expiry at which a reminder is sent, once each (idempotency key licence_id:threshold). */
export const LICENCE_REMINDER_THRESHOLDS = [60, 30, 7] as const
export type LicenceReminderThreshold = (typeof LICENCE_REMINDER_THRESHOLDS)[number]
/** The home's "Coming due" shows licences expiring within this many days. */
export const COMING_DUE_DAYS = 60

/** Whole IST calendar days from `todayIst` (YYYY-MM-DD) to `date` (YYYY-MM-DD). */
export function daysBetween(todayIst: string, date: string): number {
  const d = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)))
  return Math.round((d(date) - d(todayIst)) / 86_400_000)
}

/**
 * The ONE threshold due today, or null. A licence reaching 30 days sends the
 * 30-day reminder; one added with 5 days left sends only the 7-day one (never
 * a stale 60 / 30). Lapsed licences get nothing. `sent` = thresholds already
 * recorded for this licence.
 */
export function dueReminderThreshold(daysLeft: number | null, sent: readonly number[] = []): LicenceReminderThreshold | null {
  if (daysLeft == null || daysLeft < 0) return null
  const hit = [...LICENCE_REMINDER_THRESHOLDS].sort((a, b) => a - b).find((t) => daysLeft <= t)
  if (hit === undefined || sent.includes(hit)) return null
  return hit
}

/** "Renew" → the category page (with the service when there is one). */
export function renewHref(type: LicenceType): string {
  const r = LICENCE_TYPES[type]
  return r.service ? `/services/${r.category}/${r.service}` : `/services/${r.category}`
}

// ── "What do I need?" (obligation_rules) ───────────────────────────────────────
export const obligationRuleSchema = z.object({
  id: z.string().uuid(),
  activity: sectorSchema.nullable(),
  state: z.string().nullable(),
  sizeBand: employeeBandSchema.nullable(),
  licenceType: z.enum(LICENCE_TYPE_KEYS as [LicenceType, ...LicenceType[]]),
  categorySlug: z.string(),
  sourceUrl: z.string().url(),
  reviewedBy: z.string(),
  reviewedAt: z.string(),
})
export type ObligationRule = z.infer<typeof obligationRuleSchema>

export interface BusinessFacts {
  activity: z.infer<typeof sectorSchema> | null
  state: string | null
  sizeBand: z.infer<typeof employeeBandSchema> | null
}

/**
 * A routing checklist: reviewed rules whose every set dimension matches the
 * business (a null dimension matches anything). One row per licence type —
 * the most specific rule wins (most dimensions set), then the newest review.
 * A dimension the business hasn't told us never matches a rule that sets it.
 */
export function obligationsFor(facts: BusinessFacts, rules: readonly ObligationRule[]): ObligationRule[] {
  const specificity = (r: ObligationRule) => Number(r.activity !== null) + Number(r.state !== null) + Number(r.sizeBand !== null)
  const matches = rules.filter(
    (r) =>
      (r.activity === null || r.activity === facts.activity) &&
      (r.state === null || r.state === facts.state) &&
      (r.sizeBand === null || r.sizeBand === facts.sizeBand),
  )
  const best = new Map<LicenceType, ObligationRule>()
  for (const r of matches) {
    const cur = best.get(r.licenceType)
    if (!cur || specificity(r) > specificity(cur) || (specificity(r) === specificity(cur) && r.reviewedAt > cur.reviewedAt)) best.set(r.licenceType, r)
  }
  return LICENCE_TYPE_KEYS.filter((k) => best.has(k)).map((k) => best.get(k)!)
}
