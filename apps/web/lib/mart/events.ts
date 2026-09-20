import 'server-only'
import type { ProductEventType, AiDecisionInput } from '@amclub/shared'
import { aiDecisionCorrectedFields } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/** Append a product_events row (service role; the table is append-only). Never throws. */
export async function addProductEvent(
  admin: Admin,
  productId: string,
  actorId: string | null,
  eventType: ProductEventType,
  payload?: unknown,
): Promise<void> {
  const { error } = await admin
    .from('product_events')
    .insert({ product_id: productId, actor_id: actorId, event_type: eventType, payload: payload ?? null })
  if (error) console.error('[addProductEvent]', eventType, error.message)
}

/**
 * ai_decisions (§4.6): record proposed vs final for an AI output a human
 * confirmed/corrected. Refs only. Best-effort — must never block the flow.
 */
export async function recordAiDecision(
  admin: Admin,
  decidedBy: string,
  d: AiDecisionInput,
  /** S1.4 — runtime confirm-gate linkage (0027 columns); absent for Mart confirm-and-correct. */
  link?: { runId?: string | null; tool?: string | null },
): Promise<string | null> {
  const { data, error } = await admin
    .from('ai_decisions')
    .insert({
      feature: d.feature,
      ...(link?.runId !== undefined ? { run_id: link.runId } : {}),
      ...(link?.tool !== undefined ? { tool: link.tool } : {}),
      input_refs: d.input_refs,
      proposed: d.proposed,
      final: d.final,
      corrected_fields: aiDecisionCorrectedFields(d.proposed, d.final),
      decided_by: decidedBy,
    })
    .select('id')
    .single()
  if (error) {
    console.error('[recordAiDecision]', d.feature, error.message)
    return null
  }
  return data.id
}
