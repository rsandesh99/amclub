import { declineMessageSchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * Output schema for `decline_message@v1`. S2.1: the customer-facing contract —
 * the message reaches a provider, so it may carry no contact details, no
 * off-platform payment instruction and no URL; a violation rejects the output
 * and the route falls back to the template (the S1.2 path).
 */
export const declineMessageSchema = customerFacingText(bare, { fields: ['message'], forbid: ['contact', 'payment', 'urls'] })
export {
  declineMessageTemplate,
  messageMatchesLocaleScript,
  resolveDeclineLocale,
  QUOTE_DECLINE_REASONS,
  BUYER_DECLINE_REASONS,
  DECLINE_MESSAGE_LOCALES,
  type DeclineMessage,
  type DeclineMessageLocale,
  type QuoteDeclineReason,
} from '@amclub/shared'
