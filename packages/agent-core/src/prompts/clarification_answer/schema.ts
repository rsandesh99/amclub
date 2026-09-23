import { clarificationAnswerDraftSchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * `clarification_answer@v1` (S3.1) — the buyer's answer to a provider question, drafted ONLY from the buyer's own
 * earlier words. Every matched provider reads it once the buyer confirms, so the contact / off-platform payment /
 * urls rules apply; `acceptClarificationDraft` (shared) then checks the cited turns are the buyer's own and that no
 * price rides along.
 */
export const clarificationAnswerDraftSchema = customerFacingText(bare, { fields: ['answer'], forbid: ['contact', 'payment', 'urls'] })
export type { ClarificationAnswerDraft } from '@amclub/shared'
