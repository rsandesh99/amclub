import 'server-only'
import { effectiveLegalVersions, providerAddendumSections, type LegalDoc } from '@amclub/shared'
import { MART_ENABLED } from '@/lib/flags'

/**
 * Versions in force on THIS deployment (Launch Gate item 4): the provider
 * addendum bumps to the goods-schedule version only when MART_ENABLED=true.
 * Every server consumer (acceptance rows, /legal/status, the rendered date)
 * reads from here, never from LEGAL_VERSIONS directly.
 */
export const LEGAL_VERSIONS_EFFECTIVE: Record<LegalDoc, string> = effectiveLegalVersions({ martEnabled: MART_ENABLED })
export const PROVIDER_ADDENDUM_SECTIONS_EFFECTIVE = providerAddendumSections({ martEnabled: MART_ENABLED })
