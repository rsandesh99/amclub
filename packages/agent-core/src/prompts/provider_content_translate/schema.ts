import { contentTranslationOutputSchema } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * `provider_content_translate@v1` (E14 FR-14.3, N32b) — buyers read the approved
 * text on package and profile pages, so the customer-facing contract applies:
 * no contact details, no off-platform payment instruction, no URL. A violation
 * rejects the output and no draft is written. The numbers rule needs the
 * source, so the caller also checks `contentNumbersProblems`.
 */
export const contentTranslateSchema = customerFacingText(contentTranslationOutputSchema, { fields: ['text'], forbid: ['contact', 'payment', 'urls'] })
export type { ContentTranslationOutput } from '@amclub/shared'
