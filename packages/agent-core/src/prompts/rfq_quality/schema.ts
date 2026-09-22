import { rfqQualityModelOutputSchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * Output schema for `rfq_quality@v1`. S2.1: the questions reach the buyer —
 * no contact request, no payment, no URL; a violation rejects the model
 * output and the route serves the rule-only report (the S1.5 fallback).
 */
export const rfqQualityModelOutputSchema = customerFacingText(bare, { fields: ['gaps[].question', 'gaps[].why'], forbid: ['contact', 'payment', 'urls'] })
export {
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
