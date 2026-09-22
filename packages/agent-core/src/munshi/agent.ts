import { z } from 'zod'
import {
  clampMunshiDraft,
  munshiPriceBand,
  selectBasisRows,
  type MunshiDraft,
  type MunshiLocale,
  type MunshiPriceBand,
  type MunshiPriceBookRow,
  type MunshiSkipReason,
} from '@amclub/shared'
import type { ApprovalIntent, ThreadReplyDraft } from '@amclub/shared'
import type { AgentDefinition, AgentRun } from '../runner'
import { getPrompt } from '../prompts/registry'
import { munshiDraftSchema } from '../prompts/quote_draft/schema'
import { threadReplyDraftSchema } from '../prompts/thread_reply/schema'
import { approvalIntentSchema } from '../prompts/approval_intent/schema'
import { buildApprovalIntentParts, buildQuoteDraftParts, buildThreadReplyParts, type QuoteDraftRfqFacts, type ThreadReplyQuoteFacts } from './parts'

/**
 * The Munshi draft agent (S2.2) — ONE child run per matched RFQ. Pure: every
 * read is a tool under the provider's delegated token (`extract_requirements`
 * → GET /rfq/[id], `read_price_book` → GET /partner/price-book); the only
 * write it can propose is `submit_quote` or `ask_clarification`, both
 * confirm:true, so the run parks and nothing reaches a route until the
 * provider taps. Persistence of the draft row is a callback the runtime
 * injects (agent-owned table, service role) so this definition runs unchanged
 * under the eval harness with a fake ledger and a stub gateway.
 *
 * Laws enforced here, not in the prompt: goods → skip; already quoted / window
 * lapsed → skip without a model call; no price history → never `quote`; the
 * price band is `clampMunshiDraft`.
 */

export const munshiRfqDetailSchema = z.object({
  role: z.literal('provider'),
  rfq: z
    .object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      details: z.unknown().optional(),
      kind: z.enum(['service', 'goods']).optional(),
      categorySlug: z.string().nullable().optional(),
      budgetMinPaise: z.number().nullable().optional(),
      budgetMaxPaise: z.number().nullable().optional(),
      neededBy: z.string().nullable().optional(),
      canQuote: z.boolean(),
      declinedAt: z.string().nullable().optional(),
      myQuote: z.object({ id: z.string() }).passthrough().nullable().optional(),
      clarifications: z.array(z.object({ id: z.string(), question: z.string(), answer: z.string().nullable().optional() }).passthrough()).optional(),
    })
    .passthrough(),
})
export type MunshiRfqDetail = z.infer<typeof munshiRfqDetailSchema>

export const munshiPriceBookResponseSchema = z.object({
  rows: z.array(
    z
      .object({
        id: z.string(),
        kind: z.string(),
        category_slug: z.string(),
        specialization: z.string().nullable().optional(),
        unit: z.string().nullable().optional(),
        price_paise: z.number(),
        delivery_days: z.number().nullable().optional(),
        confirmed_at: z.string(),
        accepted_at: z.string().nullable().optional(),
      })
      .passthrough(),
  ),
})

/** Render the RFQ's stored details (a template-answers object or a string) as the untrusted details text. Keys are cleaned; values are third-party text. */
export function renderRfqDetails(details: unknown): string | null {
  if (details == null) return null
  if (typeof details === 'string') return details.trim() || null
  if (typeof details !== 'object') return null
  const lines: string[] = []
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    if (!/^[a-z0-9_]{1,40}$/i.test(k) || k === 'voice_meta') continue
    if (v == null) continue
    const val = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').join(', ') : null
    if (val && val.trim()) lines.push(`${k}: ${val.trim().slice(0, 1500)}`)
  }
  return lines.length ? lines.join('\n') : null
}

export function priceBookRowsFor(body: unknown, categorySlug: string | null): MunshiPriceBookRow[] {
  const parsed = munshiPriceBookResponseSchema.safeParse(body)
  if (!parsed.success || !categorySlug) return []
  return parsed.data.rows
    .filter((r) => r.kind === 'services' && r.category_slug === categorySlug)
    .map((r) => ({
      id: r.id,
      price_paise: r.price_paise,
      confirmed_at: r.confirmed_at,
      accepted: r.accepted_at != null,
      delivery_days: r.delivery_days ?? null,
      unit: r.unit ?? null,
      specialization: r.specialization ?? null,
    }))
}

/** The `submit_quote` payload the run proposes and the surface approves unchanged (`final`). Nulls are omitted: the route's quoteSchema takes optionals. */
export function munshiQuotePayload(draft: MunshiDraft, rfqId: string, draftId: string): Record<string, unknown> {
  const q = draft.quote
  if (!q) throw new Error('no_quote_in_draft')
  return {
    rfq_id: rfqId,
    price_paise: q.price_paise,
    delivery_days: q.delivery_days,
    scope: q.scope,
    ...(q.gst_included != null ? { gst_included: q.gst_included } : {}),
    ...(q.transport_included != null ? { transport_included: q.transport_included } : {}),
    ...(q.valid_until ? { valid_until: q.valid_until } : {}),
    ...(q.advance_percent != null ? { advance_percent: q.advance_percent } : {}),
    munshi_draft_id: draftId,
  }
}

export function munshiAskPayload(draft: MunshiDraft, rfqId: string, draftId: string): Record<string, unknown> {
  if (!draft.question) throw new Error('no_question_in_draft')
  return { rfq_id: rfqId, question: draft.question, munshi_draft_id: draftId }
}

export interface MunshiPersistArgs {
  draft: MunshiDraft
  rfq: { id: string; title: string; categorySlug: string | null }
  band: MunshiPriceBand | null
  /** true when no model was called (skip decided by code). */
  codeOnly: boolean
  /** The child run the draft belongs to (munshi_drafts.run_id). */
  runId: string
}

/** What a keyless / eval stub producer sees: the code-computed band and basis, never the buyer's text. */
export interface MunshiStubContext {
  band: MunshiPriceBand | null
  basis: readonly MunshiPriceBookRow[]
  locale: MunshiLocale
  rfqTitle: string
}

export interface MunshiDraftInput {
  rfqId: string
  locale: MunshiLocale
  /** IST date YYYY-MM-DD. */
  today: string
  providerCategories: readonly string[]
  capabilityFacts: readonly string[]
  toleranceBps: number
  /** quote_window_hours + the match's notified_at, computed by the caller (null window = never lapsed). */
  windowLapsed: boolean
  /** Write the draft row (agent-owned). Returns its id — the `munshi_draft_id` of the proposal. */
  persist: (args: MunshiPersistArgs) => Promise<{ draftId: string }>
  /** Keyless / eval producer (the harness passes a constant; the runtime derives an honest draft from the band). */
  stub?: (ctx: MunshiStubContext) => MunshiDraft
}

export interface MunshiDraftOutput {
  draftId: string
  action: MunshiDraft['action']
  skipReason: MunshiSkipReason | null
  tool: 'submit_quote' | 'ask_clarification' | null
}

const CODE_SKIP_DRAFT = (reason: MunshiSkipReason): MunshiDraft => ({
  action: 'skip',
  quote: null,
  basis: [],
  question: null,
  skip_reason: reason,
  rationale: ['Decided by code before any model call.'],
  confidence: 'high',
})

async function readRfq(run: AgentRun, rfqId: string): Promise<MunshiRfqDetail['rfq']> {
  const det = await run.proposeTool('extract_requirements', { rfq_id: rfqId })
  if (det.status !== 'done') throw new Error('unexpected_park')
  if (det.result.status === 404) throw new Error('rfq_not_found')
  if (!det.result.ok) throw new Error(`rfq_read_failed:${det.result.status}`)
  const parsed = munshiRfqDetailSchema.safeParse(det.result.body)
  if (!parsed.success) throw new Error('rfq_read_failed:shape')
  return parsed.data.rfq
}

export const munshiDraftAgent: AgentDefinition<MunshiDraftInput, MunshiDraftOutput> = {
  name: 'munshi',
  persona: 'provider',
  async run(run, input) {
    const rfq = await readRfq(run, input.rfqId)
    const kind: 'services' | 'goods' = rfq.kind === 'goods' ? 'goods' : 'services'
    const categorySlug = rfq.categorySlug ?? null
    const rfqRef = { id: rfq.id, title: rfq.title, categorySlug }

    // Code-only skips: no model call, no price book read.
    const codeSkip: MunshiSkipReason | null =
      kind === 'goods' ? 'goods_rfq' : rfq.myQuote ? 'already_quoted' : input.windowLapsed || !rfq.canQuote ? 'window_lapsed' : null
    if (codeSkip) {
      const draft = clampMunshiDraft(CODE_SKIP_DRAFT(codeSkip), { basisRows: [], toleranceBps: input.toleranceBps, rfqKind: kind, alreadyQuoted: !!rfq.myQuote, windowLapsed: codeSkip === 'window_lapsed', locale: input.locale })
      const { draftId } = await input.persist({ draft, rfq: rfqRef, band: null, codeOnly: true, runId: run.runId })
      return { draftId, action: 'skip', skipReason: draft.skip_reason, tool: null }
    }

    const pb = await run.proposeTool('read_price_book')
    if (pb.status !== 'done') throw new Error('unexpected_park')
    if (!pb.result.ok) throw new Error(`price_book_read_failed:${pb.result.status}`)
    const basis = selectBasisRows(priceBookRowsFor(pb.result.body, categorySlug))
    const band = munshiPriceBand(basis, input.toleranceBps)

    const facts: QuoteDraftRfqFacts = {
      id: rfq.id,
      kind,
      categorySlug,
      budgetMinPaise: rfq.budgetMinPaise ?? null,
      budgetMaxPaise: rfq.budgetMaxPaise ?? null,
      neededBy: rfq.neededBy ?? null,
      title: rfq.title,
      details: renderRfqDetails(rfq.details),
      clarifications: (rfq.clarifications ?? []).map((c) => ({ id: c.id, question: c.question, answer: c.answer ?? null })),
    }
    const parts = buildQuoteDraftParts({ rfq: facts, today: input.today, locale: input.locale, providerCategories: input.providerCategories, capabilityFacts: input.capabilityFacts, basis, band, toleranceBps: input.toleranceBps })
    const proposed = await run.callModel<MunshiDraft>({
      taskClass: 'quote_draft',
      prompt: getPrompt('quote_draft', 'v1'),
      schema: munshiDraftSchema,
      parts,
      temperature: 0.2,
      feature: 'munshi_draft',
      ...(input.stub ? { stub: () => input.stub!({ band, basis, locale: input.locale, rfqTitle: rfq.title }) } : {}),
    })
    const draft = clampMunshiDraft(proposed, { basisRows: basis, toleranceBps: input.toleranceBps, rfqKind: kind, alreadyQuoted: false, windowLapsed: false, locale: input.locale })
    const { draftId } = await input.persist({ draft, rfq: rfqRef, band, codeOnly: false, runId: run.runId })

    if (draft.action === 'quote') {
      await run.proposeTool('submit_quote', munshiQuotePayload(draft, rfq.id, draftId))
      return { draftId, action: 'quote', skipReason: null, tool: 'submit_quote' }
    }
    if (draft.action === 'ask') {
      await run.proposeTool('ask_clarification', munshiAskPayload(draft, rfq.id, draftId))
      return { draftId, action: 'ask', skipReason: null, tool: 'ask_clarification' }
    }
    return { draftId, action: 'skip', skipReason: draft.skip_reason, tool: null }
  },
}

// ── the thread-reply agent (S2.2 follow-up (b)) ──────────────────────────────

export interface MunshiReplyInput {
  quoteId: string
  rfqId: string | null
  rfqTitle: string | null
  locale: MunshiLocale
  today: string
  quote: ThreadReplyQuoteFacts
  scope: string
  /** Oldest first; the last one is the buyer's message being answered. Read by the follow-up under the token (a scripted GET). */
  messages: readonly { id: string; mine: boolean; body: string }[]
  persist: (args: { draft: ThreadReplyDraft; runId: string }) => Promise<{ draftId: string }>
  stub?: () => ThreadReplyDraft
}

export interface MunshiReplyOutput {
  draftId: string
  needsProviderInput: boolean
}

/** ONE model call, ONE proposal (reply_thread, confirm:true) — the run parks; the provider's tap posts the message. */
export const munshiReplyAgent: AgentDefinition<MunshiReplyInput, MunshiReplyOutput> = {
  name: 'munshi',
  persona: 'provider',
  async run(run, input) {
    const parts = buildThreadReplyParts({ quoteId: input.quoteId, locale: input.locale, today: input.today, quote: input.quote, scope: input.scope, rfqTitle: input.rfqTitle, messages: input.messages })
    const draft = await run.callModel<ThreadReplyDraft>({
      taskClass: 'thread_reply',
      prompt: getPrompt('thread_reply', 'v1'),
      schema: threadReplyDraftSchema,
      parts,
      temperature: 0.3,
      feature: 'munshi_reply',
      ...(input.stub ? { stub: input.stub } : {}),
    })
    const { draftId } = await input.persist({ draft, runId: run.runId })
    await run.proposeTool('reply_thread', { quote_id: input.quoteId, body: draft.body, munshi_draft_id: draftId })
    return { draftId, needsProviderInput: draft.needs_provider_input }
  },
}

// ── the approval-intent classifier (S2.2 decide, utterance path) ─────────────

export interface ApprovalIntentInput {
  transcript: string
  messageId: string
  locale: MunshiLocale
  draftKind: 'quote' | 'ask' | 'reply'
  via: 'audio' | 'text'
  stub?: () => ApprovalIntent
}

/**
 * ONE model call, NO tools: the output can only re-ask, treat the note as edit
 * instructions, or reject. Approval is `isUnambiguousYes` in code, checked
 * BEFORE this agent runs; a model 'approve' is treated as unclear by the caller.
 */
export const approvalIntentAgent: AgentDefinition<ApprovalIntentInput, ApprovalIntent> = {
  name: 'munshi',
  persona: 'provider',
  async run(run, input) {
    const parts = buildApprovalIntentParts({ transcript: input.transcript, messageId: input.messageId, locale: input.locale, draftKind: input.draftKind, via: input.via })
    return run.callModel<ApprovalIntent>({
      taskClass: 'approval_intent',
      prompt: getPrompt('approval_intent', 'v1'),
      schema: approvalIntentSchema,
      parts,
      temperature: 0,
      feature: 'munshi_intent',
      ...(input.stub ? { stub: input.stub } : {}),
    })
  },
}
