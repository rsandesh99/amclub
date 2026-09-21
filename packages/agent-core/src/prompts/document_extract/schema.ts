/**
 * Output schema for `document_extract@v1` (schemaRef: documentExtractSchema).
 * Strict at every level (no amount / tool / contact fields); the masking clamp
 * (`clampDocumentExtract`: GSTIN / PAN → last 4, contacts stripped) runs after
 * the model in the route AND in the eval, never before. All in @amclub/shared.
 */
export {
  documentExtractSchema,
  documentFactSchema,
  clampDocumentExtract,
  maskIdentityNumbers,
  stubDocumentExtract,
  DOC_TYPES,
  type DocumentExtract,
  type DocumentFact,
  type DocType,
} from '@amclub/shared'
