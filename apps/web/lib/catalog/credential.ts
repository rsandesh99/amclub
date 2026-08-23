/**
 * Headline professional credential for credential-first provider cards (§4.3).
 * Only the credential KIND is ever surfaced on cards — never the membership
 * number (that stays on the detail page / behind verification). KYC kinds
 * (gstin/pan/bank) are not "headline" credentials.
 */
export const PROFESSIONAL_CREDENTIAL_KINDS = [
  'icai', 'icsi', 'bar_council', 'icmai', 'gstp', 'dsa', 'ca', 'credential',
] as const

/** Pick the highest-priority professional credential kind from a set, or null. */
export function headlineCredentialKind(kinds: readonly string[]): string | null {
  for (const k of PROFESSIONAL_CREDENTIAL_KINDS) {
    if (kinds.includes(k)) return k
  }
  return null
}
