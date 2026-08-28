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
