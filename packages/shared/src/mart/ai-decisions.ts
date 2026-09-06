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
