import { comparePointersSchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * Output schema for `quote_compare@v1` (pointers). S2.1: buyer-facing lines —
 * no contact, no payment, no ranking / steering language (the S1.2 banned
 * list, now the shared RANKING_PHRASES), no URLs. `sanitizePointers` keeps
 * dropping single lines; the contract rejects the whole reply so the route
 * serves the deterministic flags alone.
 */
export const comparePointersSchema = customerFacingText(bare, { fields: ['pointers[].lines[]'], forbid: ['contact', 'payment', 'ranking', 'urls'] })
export {
  comparePointersCacheSchema,
  COMPARE_BANNED_PHRASES,
  findBannedPhrases,
  sanitizePointers,
  type ComparePointers,
  type ComparePointersCache,
  type PointerLocale,
} from '@amclub/shared'
