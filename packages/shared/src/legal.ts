import { z } from 'zod'

/**
 * Legal documents a user can accept, and the CURRENT version of each. This is
 * the single source of truth for the legal pages (rendered date), the signup
 * checkbox / re-acceptance modal, and the `terms_acceptances` rows the API
 * writes. Bump a version here when the document text changes materially —
 * every user then re-accepts on their next authenticated load.
 */
export const LEGAL_DOCS = ['terms', 'privacy', 'provider_addendum'] as const
export type LegalDoc = (typeof LEGAL_DOCS)[number]

export const LEGAL_VERSIONS: Record<LegalDoc, string> = {
  terms: '2026-07-07',
  privacy: '2026-07-07',
  provider_addendum: '2026-08-28',
}

/**
 * AMC Mart Launch Gate item 4 (MART_DESIGN.md §8): the provider addendum gains
 * a goods schedule (sections 6–8) that ships WITH the MART_ENABLED=true
 * release — never before. The bump is therefore a function of the flag, not a
 * constant edit: while the flag is off every provider keeps the services
 * version and nobody is asked to re-accept; the flip itself forces the
 * blocking re-accept. DRAFT FOR COUNSEL (§9.5 liability language).
 */
export const PROVIDER_ADDENDUM_GOODS_VERSION = '2026-09-06'
export const PROVIDER_ADDENDUM_SECTIONS = 5
export const PROVIDER_ADDENDUM_GOODS_SECTIONS = 8

/** The versions in force for a deployment. Pure so both the server and tests can call it. */
export function effectiveLegalVersions(opts: { martEnabled: boolean }): Record<LegalDoc, string> {
  return opts.martEnabled ? { ...LEGAL_VERSIONS, provider_addendum: PROVIDER_ADDENDUM_GOODS_VERSION } : { ...LEGAL_VERSIONS }
}

/** Sections the addendum page renders for a deployment. */
export function providerAddendumSections(opts: { martEnabled: boolean }): number {
  return opts.martEnabled ? PROVIDER_ADDENDUM_GOODS_SECTIONS : PROVIDER_ADDENDUM_SECTIONS
}

/** Public route for each document (locale prefix added by the i18n router). */
export const LEGAL_DOC_PATHS: Record<LegalDoc, string> = {
  terms: '/terms',
  privacy: '/privacy',
  provider_addendum: '/provider-addendum',
}

export const BUYER_LEGAL_DOCS: readonly LegalDoc[] = ['terms', 'privacy']
export const PROVIDER_LEGAL_DOCS: readonly LegalDoc[] = ['terms', 'privacy', 'provider_addendum']

/** Which documents an account must have accepted at the current versions. */
export function requiredLegalDocs(isProvider: boolean): LegalDoc[] {
  return [...(isProvider ? PROVIDER_LEGAL_DOCS : BUYER_LEGAL_DOCS)]
}

export const LEGAL_SURFACES = ['web', 'mobile'] as const
export type LegalSurface = (typeof LEGAL_SURFACES)[number]

/** POST /api/v1/legal/accept body. */
export const legalAcceptSchema = z.object({
  docs: z.array(z.enum(LEGAL_DOCS)).min(1).max(LEGAL_DOCS.length),
  surface: z.enum(LEGAL_SURFACES).default('web'),
  locale: z.string().max(8).optional(),
})
export type LegalAcceptInput = z.infer<typeof legalAcceptSchema>
