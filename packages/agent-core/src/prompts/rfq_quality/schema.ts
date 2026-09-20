/**
 * Output schema for `rfq_quality@v1` (schemaRef: rfqQualityModelOutputSchema).
 * The contract lives in @amclub/shared (rfq-quality.ts) because the web route,
 * the verify script and the eval consume it; re-exported next to the prompt so
 * the registry resolves it in one place (same pattern as quote_extract/schema.ts).
 * The model returns ONLY `{ specific_enough, gaps }`; the server merges it into
 * the report under the union rule (`mergeQualityReport`).
 */
export {
  rfqQualityModelOutputSchema,
  rfqQualityReportSchema,
  rfqQualityPrecheck,
  mergeQualityReport,
  RFQ_QUALITY_GAPS,
  RFQ_QUALITY_RISKS,
  RFQ_QUALITY_LOCALES,
  RFQ_QUALITY_STUB_QUESTIONS,
  type RfqQualityModelOutput,
  type RfqQualityReport,
  type RfqQualityPrecheckResult,
  type RfqQualityLocale,
} from '@amclub/shared'
