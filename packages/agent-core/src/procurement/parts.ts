import type { ProcurementLocale } from '@amclub/shared'
import { envelope } from '../untrusted/envelope'
import type { ChatParts } from '../llm/gateway'

/**
 * Prompt parts for the three procurement prompts (S3.1). Trusted = platform
 * facts only: the locale, the session state, whether a request exists, its
 * title (≤ 60 chars, cleaned — the S2.3 request-titles precedent), the LETTERS
 * of the live quotes (never prices, never provider names), what the assistant
 * is waiting for, the open proposal's tool, and turn ids. Untrusted = every
 * word a person wrote: the buyer's message, the buyer's earlier turns, and a
 * provider's question (third-party text, surface quote_text). The taint test
 * asserts no message string ever reaches a trusted line.
 */

function line(s: string, max = 120): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/[<>"]/g, '').trim().slice(0, max)
}

export type ProcurementChannel = 'whatsapp' | 'support_chat'

export interface ProcurementTurnPartsInput {
  text: string
  messageId: string
  channel: ProcurementChannel
  locale: ProcurementLocale
  state: string | null
  hasRequest: boolean
  requestTitle: string | null
  /** Letters of the LIVE quotes, in the compare page's order. */
  quoteLabels: readonly string[]
  waitingFor: 'none' | 'clarify_answer' | 'quality_answers' | 'relay_answer' | 'label_pick'
  openProposal: string | null
}

export function buildProcurementTurnParts(input: ProcurementTurnPartsInput): ChatParts {
  const trusted = [
    `locale: ${input.locale}`,
    `state: ${input.state ?? 'none'}`,
    `has_request: ${input.hasRequest ? 'yes' : 'no'}`,
    `request_title: ${input.requestTitle ? `"${line(input.requestTitle, 60)}"` : 'none'}`,
    `quote_labels: ${input.quoteLabels.filter((l) => /^[A-G]$/.test(l)).join(' ') || 'none'}`,
    `waiting_for: ${input.waitingFor}`,
    `open_proposal: ${input.openProposal ? line(input.openProposal, 40) : 'none'}`,
  ]
  return { trusted, untrusted: [envelope(input.text, { kind: input.channel, id: input.messageId })] }
}

export interface ClarificationAnswerPartsInput {
  clarificationId: string
  question: string
  locale: ProcurementLocale
  today: string
  requestTitle: string | null
  /** The buyer's own earlier turns, oldest first (≤ 8 are sent). */
  buyerTurns: readonly { id: string; text: string; channel: ProcurementChannel }[]
}

export function buildClarificationAnswerParts(input: ClarificationAnswerPartsInput): ChatParts {
  const turns = input.buyerTurns.slice(-8)
  const trusted = [
    `today: ${line(input.today, 10)}`,
    `locale: ${input.locale}`,
    `request_title: ${input.requestTitle ? `"${line(input.requestTitle, 60)}"` : 'none'}`,
    `buyer_turn_ids: ${turns.map((t) => line(t.id, 40)).join(', ') || 'none'}`,
  ]
  const untrusted = [
    // the provider's question is third-party text (the S2.1 quote_text surface)
    envelope(input.question, { kind: 'quote_text', id: input.clarificationId }),
    ...turns.map((t) => envelope(t.text, { kind: t.channel, id: t.id })),
  ]
  return { trusted, untrusted }
}

export interface ProviderMessagePartsInput {
  text: string
  messageId: string
  channel: ProcurementChannel
  locale: ProcurementLocale
  requestTitle: string | null
  providerLabel: string
}

export function buildProviderMessageParts(input: ProviderMessagePartsInput): ChatParts {
  const trusted = [
    `locale: ${input.locale}`,
    `request_title: ${input.requestTitle ? `"${line(input.requestTitle, 60)}"` : 'none'}`,
    `provider_label: ${/^[A-G]$/.test(input.providerLabel) ? input.providerLabel : 'unknown'}`,
  ]
  return { trusted, untrusted: [envelope(input.text, { kind: input.channel, id: input.messageId })] }
}
