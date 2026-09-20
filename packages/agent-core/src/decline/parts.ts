import type { DeclineMessageLocale, QuoteDeclineReason } from '@amclub/shared'
import { envelope } from '../untrusted/envelope'
import type { ChatParts } from '../llm/gateway'

/**
 * Prompt parts for `decline_message@v1` (S1.2 §2). Trusted: ONLY the reason
 * code and the target locale. The buyer's note and the RFQ title are other
 * people's words → Envelopes in `untrusted`; the taint test asserts they never
 * appear in `trusted`.
 */
export interface DeclineMessagePartsInput {
  reason: QuoteDeclineReason
  locale: DeclineMessageLocale
  note?: string | null
  rfqTitle?: string | null
  quoteId: string
  rfqId: string
}

export function buildDeclineMessageParts(input: DeclineMessagePartsInput): ChatParts {
  const untrusted = []
  if (input.note && input.note.trim()) untrusted.push(envelope(input.note, { kind: 'decline_note', id: input.quoteId }))
  if (input.rfqTitle && input.rfqTitle.trim()) untrusted.push(envelope(input.rfqTitle, { kind: 'rfq_title', id: input.rfqId }))
  return {
    trusted: [`reason: ${input.reason}`, `locale: ${input.locale}`],
    ...(untrusted.length ? { untrusted } : {}),
  }
}
