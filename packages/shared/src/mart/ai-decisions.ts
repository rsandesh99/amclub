/**
 * ai_decisions (MART_DESIGN.md §4.6) — append-only record of every AI output a
 * human confirms or corrects. Built in M0 because it cannot be backfilled.
 * Refs only (ids, storage keys), never PII blobs.
 */
import { z } from 'zod'

export const AI_DECISION_FEATURES = [
  'catalog_draft',
  'payout_dossier',
  'extraction_correction',
  // M1 (0023 widens the CHECK): Group-Buy Agent pool terms, its vernacular card line, Documents Agent drafts.
  'pool_draft',
  'pool_card',
  'documents_draft',
  // Agent programme (0027 lifts ai_decisions out of staged Mart + widens the CHECK
  // to the whole programme). Every runtime confirm-gate write uses one of these.
  'agent_tool',        // generic runtime tool confirmation (run_id + tool set)
  'quote_extraction',  // S1.1
  'decline_message',   // S1.2 / S0.4
  'onboarding',        // S1.6
  'dispute_triage',    // S1.7
  'rfq_quality',       // S1.5
  'rfq_intake',        // S1.8 — the Create tap confirming voice-clarify / document / drawing prefill
  'munshi_draft',      // S2.2 — the provider's tap on a Munshi quote / question draft (tool submit_quote | ask_clarification)
  'munshi_reply',      // S2.2 — the provider's tap on a Munshi thread-reply draft (tool reply_thread)
  'support_nudge',     // S2.3 — the user's confirm on a Support-agent nudge (tool nudge_counterparty)
  'support_reply',     // S2.3
  'score_note',        // S2.4
  'procurement_step',  // S3.1 — the buyer's confirm on a procurement proposal (create_rfq, complete_rfq, answer_clarification, message_provider, decline_quote, choose_quote, the chase nudge)
  'content_translation', // E14 N32b — the provider's approve on one language of their own catalogue copy (0061 widens the CHECK)
] as const
export type AiDecisionFeature = (typeof AI_DECISION_FEATURES)[number]

export const aiDecisionSchema = z.object({
  feature: z.enum(AI_DECISION_FEATURES),
  /** e.g. { product_id, image_keys[], ai_invocation_id } — references, not content. */
  input_refs: z.record(z.string(), z.unknown()),
  proposed: z.record(z.string(), z.unknown()),
  final: z.record(z.string(), z.unknown()),
})
export type AiDecisionInput = z.infer<typeof aiDecisionSchema>

/**
 * Per-field diff of proposed vs final — the training signal. Keys whose value
 * the human changed (deep-equal by JSON) are listed; unchanged keys are not.
 */
export function aiDecisionCorrectedFields(proposed: Record<string, unknown>, final: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(proposed), ...Object.keys(final)])
  const out: string[] = []
  for (const k of keys) {
    if (JSON.stringify(proposed[k] ?? null) !== JSON.stringify(final[k] ?? null)) out.push(k)
  }
  return out.sort()
}

/** Catalog Agent draft — the shape the model must return (all fields nullable = "unsure"). */
export const catalogDraftSchema = z.object({
  name: z.string().max(140).nullable(),
  description: z.string().max(2000).nullable(),
  category_slug: z.string().max(60).nullable(),
  hsn_code: z.string().max(8).nullable(),
  gst_rate_bps: z.number().int().nullable(),
  unit: z.string().max(10).nullable(),
  /** Suggested tiers; the seller confirms or rewrites every row. */
  tiers: z.array(z.object({ min_qty: z.number().int().positive(), unit_price_paise: z.number().int().positive() })).max(8).nullable(),
  uncertain: z.boolean(),
})
export type CatalogDraft = z.infer<typeof catalogDraftSchema>
