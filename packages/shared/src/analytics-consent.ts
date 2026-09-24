import { z } from 'zod'

/**
 * E17 (N36, gated on D-UX2) — analytics consent. Built dark: it only matters
 * when counsel decides first-party pseudonymous product analytics needs
 * consent under the DPDP Act and the NEXT_PUBLIC_ANALYTICS_CONSENT_REQUIRED
 * build flag is turned on. Then PostHog does not load until the person
 * accepts; declining means no analytics events at all. The notice is
 * versioned like the legal documents: a new version asks again.
 */
export const ANALYTICS_NOTICE_VERSION = '2026-09-23'
export const ANALYTICS_CONSENT_COOKIE = 'amc_analytics_consent'
/** A year; the notice asks again when the version changes, whichever comes first. */
export const ANALYTICS_CONSENT_MAX_AGE_S = 365 * 24 * 3600

export const analyticsConsentChoiceSchema = z.enum(['granted', 'denied'])
export type AnalyticsConsentChoice = z.infer<typeof analyticsConsentChoiceSchema>

export const analyticsConsentBodySchema = z.object({ choice: analyticsConsentChoiceSchema }).strict()

/** What `users.analytics_consent` stores (and the cookie encodes as `<choice>.<version>`). */
export const analyticsConsentRecordSchema = z.object({
  choice: analyticsConsentChoiceSchema,
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  at: z.string(),
})
export type AnalyticsConsentRecord = z.infer<typeof analyticsConsentRecordSchema>

export function encodeConsentCookie(choice: AnalyticsConsentChoice, version = ANALYTICS_NOTICE_VERSION): string {
  return `${choice}.${version}`
}

/** The cookie's choice — only when it was given for the CURRENT notice version (else null: ask again). */
export function currentConsentFromCookie(value: string | null | undefined, version = ANALYTICS_NOTICE_VERSION): AnalyticsConsentChoice | null {
  if (!value) return null
  const [choice, v] = value.split('.')
  const c = analyticsConsentChoiceSchema.safeParse(choice)
  return c.success && v === version ? c.data : null
}

/** A stored record's choice, when current. */
export function currentConsentFromRecord(record: unknown, version = ANALYTICS_NOTICE_VERSION): AnalyticsConsentChoice | null {
  const r = analyticsConsentRecordSchema.safeParse(record)
  return r.success && r.data.version === version ? r.data.choice : null
}

/** Consent rate over current-version records (null with none) — reported as its own metric. */
export function consentRate(records: readonly unknown[], version = ANALYTICS_NOTICE_VERSION): { granted: number; denied: number; rate: number | null } {
  let granted = 0
  let denied = 0
  for (const r of records) {
    const c = currentConsentFromRecord(r, version)
    if (c === 'granted') granted++
    else if (c === 'denied') denied++
  }
  return { granted, denied, rate: granted + denied ? granted / (granted + denied) : null }
}
