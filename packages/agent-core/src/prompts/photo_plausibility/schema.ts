import { photoPlausibilitySchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * Output schema for `photo_plausibility@v1` (S1.4). Ops-only card: S2.1 opts
 * it in for contact and URLs only (the payment rule does not apply to the
 * founder's console); approval words are the card's vocabulary.
 */
export const photoPlausibilitySchema = customerFacingText(bare, { fields: ['findings[].concerns[]'], forbid: ['contact', 'urls'] })
export {
  photoFindingSchema,
  photoFindingPasses,
  photoFindingFailures,
  PHOTO_CONFIDENCE_MIN,
  type PhotoPlausibility,
  type PhotoFinding,
} from '@amclub/shared'
