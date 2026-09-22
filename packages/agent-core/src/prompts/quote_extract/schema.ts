import { quoteExtractionSchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * Output schema for `quote_extract@v1`. S2.1: the scope summary is shown to
 * the provider and travels into the quote the buyer reads — no contact, no
 * payment, no URL. `stripContactInfo` still masks at clamp time; the contract
 * rejects the model output so the route serves an empty extraction.
 */
export const quoteExtractionSchema = customerFacingText(bare, { fields: ['scope_summary'], forbid: ['contact', 'payment', 'urls'] })
export {
  quoteExtractRequestSchema,
  quoteExtractResponseSchema,
  QUOTE_EXTRACT_FIELDS,
  clampQuoteExtraction,
  emptyExtraction,
  editedExtractFields,
  stripContactInfo,
  type QuoteExtraction,
  type QuoteExtractField,
  type QuoteExtractKind,
} from '@amclub/shared'
