/**
 * Output schema for `quote_extract@v1` (schemaRef: quoteExtractionSchema). The
 * contract lives in @amclub/shared (quote-extraction.ts) because web, mobile
 * and the verify script consume it; re-exported next to the prompt like
 * prompts/photo_plausibility/schema.ts so the registry resolves it in one place.
 */
export {
  quoteExtractionSchema,
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
