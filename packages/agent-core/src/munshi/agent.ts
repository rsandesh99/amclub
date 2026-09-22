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
import type { AgentDefinition, AgentRun } from '../runner'
import { getPrompt } from '../prompts/registry'
import { munshiDraftSchema } from '../prompts/quote_draft/schema'
import { buildQuoteDraftParts, type QuoteDraftRfqFacts } from './parts'

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
  /** Keyless / eval producer. */
  stub?: () => MunshiDraft
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
      const { draftId } = await input.persist({ draft, rfq: rfqRef, band: null, codeOnly: true })
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
      ...(input.stub ? { stub: input.stub } : {}),
    })
    const draft = clampMunshiDraft(proposed, { basisRows: basis, toleranceBps: input.toleranceBps, rfqKind: kind, alreadyQuoted: false, windowLapsed: false, locale: input.locale })
    const { draftId } = await input.persist({ draft, rfq: rfqRef, band, codeOnly: false })

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
