import { documentExtractSchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * Output schema for `document_extract@v1`. S2.1: the description and the
 * fact values reach the buyer's form (and the matched providers) — no URL, no
 * payment instruction. Contact details are handled by the S1.8 masking clamp
 * (identity numbers to the last 4, phones / emails stripped) which runs AFTER
 * parse; masked forms pass this contract (asserted in the eval).
 */
export const documentExtractSchema = customerFacingText(bare, { fields: ['description_english', 'facts[].v'], forbid: ['urls', 'payment'] })
export {
  documentFactSchema,
  clampDocumentExtract,
  maskIdentityNumbers,
  stubDocumentExtract,
  DOC_TYPES,
  type DocumentExtract,
  type DocumentFact,
  type DocType,
} from '@amclub/shared'
