import { CATEGORY_SLUGS, type CategorySlug } from './categories'

/**
 * Curated specialization vocabulary per category (Phase 8b — Voice RFQ).
 * These are the ONLY specialization values the voice parser may emit; anything
 * outside the list must come back as null + uncertain rather than a guess.
 * Derived from the category service descriptions (§1.10). Slugs are stable —
 * they land in rfqs.voice_meta and PostHog, so rename via migration only.
 */

export const SPECIALIZATIONS: Record<CategorySlug, readonly string[]> = {
  'company-registrations': [
    'pvt-ltd-incorporation',
    'llp-incorporation',
    'opc-incorporation',
    'udyam-registration',
    'gst-registration',
    'fssai-license',
    'iec-code',
    'msme-certificate',
  ],
  'tax-accounting': ['gst-filing', 'itr-filing', 'bookkeeping', 'audit', 'tds-compliance'],
  legal: ['contract-drafting', 'trademark', 'ip-protection', 'legal-notice', 'labour-law-compliance'],
  'hr-staffing': ['recruitment', 'payroll', 'hr-policy-setup'],
  'finance-facilitation': [
    'loan-documentation',
    'dsa-services',
    'cgtmse-application',
    'mudra-application',
    'project-report',
  ],
  'digital-marketing': ['social-media', 'seo', 'performance-ads', 'branding'],
  'web-tech': ['website-development', 'ecommerce-setup', 'ondc-onboarding', 'app-development'],
  'government-licensing': [
    'factory-license',
    'pollution-noc',
    'subsidy-application',
    'pmegp-application',
    'gem-onboarding',
    'tender-support',
  ],
}

export const ALL_SPECIALIZATIONS: readonly string[] = CATEGORY_SLUGS.flatMap((s) => [
  ...SPECIALIZATIONS[s],
])

/** True when `spec` belongs to `category`'s curated vocabulary. */
export function isSpecializationOf(category: CategorySlug, spec: string): boolean {
  return (SPECIALIZATIONS[category] ?? []).includes(spec)
}
