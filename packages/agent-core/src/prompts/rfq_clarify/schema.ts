import { clarifyQuestionSchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * Output schema for `rfq_clarify@v1`. S2.1: the ONE question reaches the
 * buyer (and may be spoken) — no contact request, no payment, no URL; a
 * violation rejects it and the route asks the fixed per-gap question.
 */
export const clarifyQuestionSchema = customerFacingText(bare, { fields: ['question'], forbid: ['contact', 'payment', 'urls'] })
export {
  CLARIFY_GAP_KEYWORDS,
  CLARIFY_SCRIPT_RE,
  clarifyLocaleFor,
  needsClarification,
  stubClarifyQuestion,
  type ClarifyQuestion,
} from '@amclub/shared'
