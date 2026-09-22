import type { MunshiLocale, MunshiPriceBand, MunshiPriceBookRow } from '@amclub/shared'
import { formatRupees } from '@amclub/shared'
import { envelope } from '../untrusted/envelope'
import type { ChatParts } from '../llm/gateway'

/**
 * Prompt parts for the three Munshi prompts (S2.2). The rule is the S1.x rule:
 * everything a third party typed — the RFQ title and details, clarification
 * questions and answers, the buyer's thread messages, a voice transcript —
 * enters ONLY as an Envelope in `untrusted`. `trusted` carries facts the
 * platform owns: today, the locale, the category graph, the provider's own
 * price-book rows (platform records of the provider's past quotes), the
 * code-computed price band, and the capability facts the provider confirmed
 * by button (S1.6). The taint tests assert no third-party string reaches a
 * trusted line.
 */

function line(s: string, max = 200): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/[<>]/g, '').trim().slice(0, max)
}

export interface QuoteDraftRfqFacts {
  id: string
  kind: 'services' | 'goods'
  categorySlug: string | null
  budgetMinPaise: number | null
  budgetMaxPaise: number | null
  neededBy: string | null
  /** Third-party text — untrusted. */
  title: string
  details: string | null
  clarifications: readonly { id: string; question: string; answer: string | null }[]
  transcript?: string | null
}

export interface QuoteDraftPartsInput {
  rfq: QuoteDraftRfqFacts
  /** IST date, YYYY-MM-DD. */
  today: string
  locale: MunshiLocale
  providerCategories: readonly string[]
  /** Facts the provider confirmed by button (S1.6) — the provider's own words, confirmed; single-line, capped. */
  capabilityFacts: readonly string[]
  /** The code-selected basis rows (accepted first, newest, ≤ 5). */
  basis: readonly MunshiPriceBookRow[]
  band: MunshiPriceBand | null
  toleranceBps: number
}

export function buildQuoteDraftParts(input: QuoteDraftPartsInput): ChatParts {
  const { rfq } = input
  const trusted: string[] = [
    `today: ${input.today}`,
    `locale: ${input.locale}`,
    `rfq_kind: ${rfq.kind}`,
    `rfq_category: ${rfq.categorySlug ?? 'unknown'}`,
    `provider_categories: ${input.providerCategories.length ? input.providerCategories.join(', ') : 'none on record'}`,
    `budget_range_paise: ${rfq.budgetMinPaise != null || rfq.budgetMaxPaise != null ? `${rfq.budgetMinPaise ?? '?'}–${rfq.budgetMaxPaise ?? '?'}` : 'not stated'}`,
    `needed_by: ${rfq.neededBy ?? 'not stated'}`,
  ]
  if (input.band) {
    trusted.push(`price_band_paise: ${input.band.min_paise}..${input.band.max_paise} (${formatRupees(input.band.min_paise)}–${formatRupees(input.band.max_paise)}; tolerance ${input.toleranceBps / 100} % around your basis rows). A quote price MUST lie inside this band.`)
    trusted.push('basis_rows (your own past quotes in this category; copy the rows you rely on into `basis` verbatim):')
    for (const r of input.basis) {
      trusted.push(`- price_book_id=${r.id} price_paise=${r.price_paise} (${formatRupees(r.price_paise)}) delivery_days=${r.delivery_days ?? '?'} accepted=${r.accepted} confirmed_at=${r.confirmed_at}${r.unit ? ` unit=${line(r.unit, 40)}` : ''}${r.specialization ? ` specialization=${line(r.specialization, 60)}` : ''}`)
    }
  } else {
    trusted.push('price_band: none — you have NO price history in this category. Never output action=quote; choose ask (one question) or skip (no_price_history).')
  }
  if (input.capabilityFacts.length) {
    trusted.push('capability_facts (confirmed by the provider):')
    for (const f of input.capabilityFacts.slice(0, 12)) trusted.push(`- ${line(f)}`)
  } else {
    trusted.push('capability_facts: none confirmed yet')
  }

  const untrusted = [envelope(rfq.title || '(untitled)', { kind: 'rfq_title', id: rfq.id })]
  if (rfq.details && rfq.details.trim()) untrusted.push(envelope(rfq.details, { kind: 'rfq_details', id: rfq.id }))
  for (const c of rfq.clarifications.slice(0, 10)) {
    const text = c.answer && c.answer.trim() ? `Q: ${c.question}\nA: ${c.answer}` : `Q: ${c.question}\nA: (not answered yet)`
    untrusted.push(envelope(text, { kind: 'rfq_clarification', id: c.id }))
  }
  if (rfq.transcript && rfq.transcript.trim()) untrusted.push(envelope(rfq.transcript, { kind: 'voice_transcript', id: rfq.id }))
  return { trusted, untrusted }
}

export interface ApprovalIntentPartsInput {
  transcript: string
  messageId: string
  locale: MunshiLocale
  draftKind: 'quote' | 'ask' | 'reply'
  via: 'audio' | 'text'
}

/** The classifier sees ONLY the provider's utterance (untrusted) and the draft kind; it is told it can never approve. */
export function buildApprovalIntentParts(input: ApprovalIntentPartsInput): ChatParts {
  return {
    trusted: [
      `locale: ${input.locale}`,
      `draft_kind: ${input.draftKind}`,
      `channel: whatsapp ${input.via}`,
      'note: approval is decided by code from a fixed allow-list of yes phrases; your output can never approve or send anything.',
    ],
    untrusted: [envelope(input.transcript, { kind: 'provider_utterance', id: input.messageId })],
  }
}

export interface ThreadReplyQuoteFacts {
  price_paise: number
  delivery_days: number
  gst_included: boolean | null
  transport_included: boolean | null
  valid_until: string | null
  advance_percent: number | null
  status: string
}

export interface ThreadReplyPartsInput {
  quoteId: string
  locale: MunshiLocale
  today: string
  quote: ThreadReplyQuoteFacts
  /** The provider's own quote scope — the provider's words, still an Envelope (quote_text). */
  scope: string
  rfqTitle: string | null
  /** Oldest first; ≤ 12 are sent. `mine` = the provider's own message. */
  messages: readonly { id: string; mine: boolean; body: string }[]
}

export function buildThreadReplyParts(input: ThreadReplyPartsInput): ChatParts {
  const q = input.quote
  const trusted = [
    `today: ${input.today}`,
    `locale: ${input.locale}`,
    `quote_facts: price=${formatRupees(q.price_paise)} (${q.price_paise} paise) delivery_days=${q.delivery_days} gst_included=${q.gst_included ?? 'not stated'} transport_included=${q.transport_included ?? 'not stated'} valid_until=${q.valid_until ?? 'not stated'} advance_percent=${q.advance_percent ?? 'not stated'} status=${q.status}`,
    'rules: reply to the LAST buyer message only; never change or promise a price, date or term that is not in quote_facts; no contact details; no links; if the buyer asks something only the provider knows, set needs_provider_input=true and write a short holding reply.',
  ]
  const untrusted = [envelope(input.scope || '(no scope text)', { kind: 'quote_text', id: input.quoteId })]
  if (input.rfqTitle && input.rfqTitle.trim()) untrusted.push(envelope(input.rfqTitle, { kind: 'rfq_title', id: input.quoteId }))
  for (const m of input.messages.slice(-12)) {
    untrusted.push(envelope(m.body, { kind: m.mine ? 'quote_message_provider' : 'quote_message_buyer', id: m.id }))
  }
  return { trusted, untrusted }
}
