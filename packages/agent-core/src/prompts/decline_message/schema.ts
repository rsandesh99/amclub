/**
 * Output schema for `decline_message@v1` (schemaRef: declineMessageSchema).
 * Contract + the fixed fallback templates live in @amclub/shared
 * (decline-message.ts); re-exported next to the prompt (the S1.1 pattern).
 */
export {
  declineMessageSchema,
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
