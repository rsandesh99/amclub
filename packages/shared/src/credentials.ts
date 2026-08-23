import type { CategorySlug } from './categories'

/**
 * Per-category professional credential model (launch-day fix, 2026-08-23).
 *
 * The gateway wizard previously offered the same four credentials (CA/CS/
 * Advocate/Firm) for every category, and onboarding stored every upload as a
 * generic `kind: 'credential'` row with no credential type or membership
 * number. This module is the single source of truth for:
 *   - which credential types are plausible per category (wizard options),
 *   - which of those are statutory (need a registration number + document),
 *   - which categories REQUIRE a statutory credential to list at all,
 *   - the mapping from wizard-facing option ids to the canonical
 *     provider_verifications.kind values the rest of the platform already
 *     understands (search headline RPC, badges, admin queue).
 */

/** Wizard-facing credential option ids (stable — stored in gateway drafts). */
export const CREDENTIAL_OPTIONS = [
  'ca', //         Chartered Accountant — ICAI member
  'cs', //         Company Secretary — ICSI member
  'cma', //        Cost & Management Accountant — ICMAI member
  'adv', //        Advocate — Bar Council enrolled
  'gstp', //       GST Practitioner — GST-portal registered
  'dsa', //        Loan DSA / bank-NBFC channel partner (empanelment letter)
  'firm', //       Registered firm or agency (GSTIN-verified business)
  'freelancer', // Independent professional (portfolio-based fields)
] as const
export type CredentialOption = (typeof CREDENTIAL_OPTIONS)[number]

/**
 * Statutory credentials: membership/enrolment NUMBER + certificate upload are
 * captured and manually verified. `firm`/`freelancer` are business identities,
 * verified through GSTIN/profile instead.
 */
export const STATUTORY_CREDENTIALS: readonly CredentialOption[] = [
  'ca', 'cs', 'cma', 'adv', 'gstp', 'dsa',
]

export const isStatutoryCredential = (o: string): o is CredentialOption =>
  (STATUTORY_CREDENTIALS as readonly string[]).includes(o)

/**
 * Wizard option → canonical provider_verifications.kind. The canonical names
 * are the professional-body kinds the platform already renders (badges,
 * headline-credential RPC, admin queue) — never invent parallel spellings.
 */
export const CREDENTIAL_VERIFICATION_KIND: Record<CredentialOption, string> = {
  ca: 'icai',
  cs: 'icsi',
  cma: 'icmai',
  adv: 'bar_council',
  gstp: 'gstp',
  dsa: 'dsa',
  firm: 'credential',
  freelancer: 'credential',
}

/**
 * Which credential types make sense per category, most-typical first (drives
 * the gateway wizard step and the onboarding credential-type picker).
 *
 * Grounding:
 * - tax-accounting: ITR/GST/audit work — CA; CMA for cost records; GST
 *   Practitioners are portal-registered for GST filings; firms employ them.
 * - company-registrations: SPICe+/MCA filings are certified by CS/CA/CMA or an
 *   Advocate in practice; incorporation agencies exist but must employ one.
 * - legal: Advocates (Bar Council) — law firms are collections of them.
 * - finance-facilitation: loan DSAs (bank/NBFC empanelment), CAs preparing
 *   project reports, registered consultancies. Lending itself is out of scope.
 * - government-licensing: liaison consultants (registered firms); Advocates
 *   and CAs also practise here. No single statutory body.
 * - hr-staffing / digital-marketing / web-tech: no statutory body — registered
 *   firms or independent professionals with portfolios.
 */
export const CATEGORY_CREDENTIALS: Record<CategorySlug, readonly CredentialOption[]> = {
  'tax-accounting': ['ca', 'cma', 'gstp', 'firm'],
  'company-registrations': ['cs', 'ca', 'cma', 'adv', 'firm'],
  legal: ['adv', 'firm'],
  'hr-staffing': ['firm', 'freelancer'],
  'finance-facilitation': ['dsa', 'ca', 'firm'],
  'digital-marketing': ['firm', 'freelancer'],
  'web-tech': ['firm', 'freelancer'],
  'government-licensing': ['firm', 'adv', 'ca'],
}

/** Wizard/onboarding options for a category (full list if slug unknown). */
export function credentialOptionsForCategory(slug: string): readonly CredentialOption[] {
  return CATEGORY_CREDENTIALS[slug as CategorySlug] ?? CREDENTIAL_OPTIONS
}

/**
 * Categories where listing REQUIRES a statutory credential (type + number +
 * certificate). Buyers here rely on the credential itself, and the work is
 * restricted to licensed professionals in practice.
 * NOTE: company-registrations was previously gated on GSTIN only — that was a
 * gap; MCA incorporation filings need a certifying professional.
 */
export const CREDENTIAL_REQUIRED_CATEGORIES: readonly CategorySlug[] = [
  'tax-accounting',
  'legal',
  'company-registrations',
]

export function categoryRequiresStatutoryCredential(slug: string): boolean {
  return (CREDENTIAL_REQUIRED_CATEGORIES as readonly string[]).includes(slug)
}

/** Statutory options offered for a category's required-credential picker. */
export function statutoryOptionsForCategory(slug: string): readonly CredentialOption[] {
  return credentialOptionsForCategory(slug).filter((o) => isStatutoryCredential(o))
}

/** Subset of the given category slugs that require a statutory credential. */
export function categoriesRequiringCredential(slugs: string[]): string[] {
  return slugs.filter((s) => categoryRequiresStatutoryCredential(s))
}
