import { redactContactInfo, type SupportIntent, type SupportLocale } from '@amclub/shared'
import { envelope } from '../untrusted/envelope'
import type { ChatParts } from '../llm/gateway'

/**
 * Prompt parts for the two Support prompts (S2.3). Trusted = platform facts
 * only: the user's roles, locale, the last three turns' INTENTS (never their
 * text), and the user's recent order numbers / request titles as a reference
 * list (ids + numbers, ≤ 10 each). Untrusted = the message (and the previous
 * user message when present) as Envelopes. The taint test asserts no message
 * string reaches a trusted line.
 */

function line(s: string, max = 120): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/[<>]/g, '').trim().slice(0, max)
}

export interface SupportIntentPartsInput {
  text: string
  messageId: string
  channel: 'whatsapp' | 'support_chat'
  roles: readonly ('buyer' | 'provider')[]
  locale: SupportLocale
  recentIntents: readonly SupportIntent[]
  unclearStreak: number
  /** Platform data: the user's recent orders (numbers) and requests (titles, ≤ 60 chars). */
  orders: readonly { number: string }[]
  rfqs: readonly { title: string }[]
  previousText?: string | null
  previousMessageId?: string | null
}

export function buildSupportIntentParts(input: SupportIntentPartsInput): ChatParts {
  const trusted = [
    `roles: ${input.roles.join(', ') || 'none'}`,
    `locale: ${input.locale}`,
    `recent_intents: ${input.recentIntents.slice(-3).join(', ') || 'none'}`,
    `unclear_streak: ${input.unclearStreak}`,
    `order_numbers: ${input.orders.length ? input.orders.slice(0, 10).map((o) => line(o.number, 40)).join(' | ') : 'none'}`,
    `request_titles: ${input.rfqs.length ? input.rfqs.slice(0, 10).map((r) => `"${line(r.title, 60)}"`).join(' | ') : 'none'}`,
  ]
  // audit M23: the live message (and the previous one) is contact-masked BEFORE it reaches the prompt — the stored copy
  // already was (support_messages, the ticket transcript); a phone number or email never needs to leave for a classifier
  const untrusted = [envelope(redactContactInfo(input.text).text, { kind: input.channel, id: input.messageId })]
  if (input.previousText && input.previousText.trim()) untrusted.push(envelope(redactContactInfo(input.previousText).text, { kind: `${input.channel}_previous`, id: input.previousMessageId ?? `${input.messageId}-prev` }))
  return { trusted, untrusted }
}

export interface TicketSummaryPartsInput {
  ticketId: string
  locale: SupportLocale
  role: 'buyer' | 'provider'
  channel: 'whatsapp' | 'web' | 'mobile'
  /** Platform facts about the linked subject (numbers / statuses only). */
  order?: { order_number: string; status: string; amount: string } | null
  rfq?: { title: string; status: string; quote_count: number } | null
  reason: string
  /** Oldest first; ≤ 6 turns are sent. */
  transcript: readonly { id: string; role: 'user' | 'assistant'; text: string }[]
}

export function buildTicketSummaryParts(input: TicketSummaryPartsInput): ChatParts {
  const trusted = [
    `role: ${input.role}`,
    `channel: ${input.channel}`,
    `locale: ${input.locale}`,
    `escalation_reason: ${line(input.reason, 60)}`,
    input.order ? `order: number=${line(input.order.order_number, 40)} status=${line(input.order.status, 40)} amount=${line(input.order.amount, 20)}` : 'order: none',
    input.rfq ? `request: title="${line(input.rfq.title, 60)}" status=${line(input.rfq.status, 40)} quotes=${input.rfq.quote_count}` : 'request: none',
  ]
  // audit M23: a user turn may arrive unmasked (the runtime posts WhatsApp bodies) — masked here, before the prompt
  const untrusted = input.transcript.slice(-6).map((t) => envelope(t.role === 'user' ? redactContactInfo(t.text).text : t.text, { kind: t.role === 'user' ? 'support_transcript_user' : 'support_transcript_assistant', id: t.id }))
  return { trusted, untrusted }
}
