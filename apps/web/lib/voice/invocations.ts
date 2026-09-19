import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import { tierFor, type AgentTaskClass, type AgentTier } from '@amclub/shared'
// Pure cost math lives in @amclub/agent-core now — ONE place shared with the
// runtime (ADR-009 §1). Re-exported so existing importers keep their import.
import { tokensFromUsage, estimateSttCostPaise, estimateParseCostPaise } from '@amclub/agent-core'

export { estimateSttCostPaise, estimateParseCostPaise }

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * ai_invocations telemetry (§Phase 8b v1.1 — AI cost observability). One row
 * per model call: vendor, status, latency, and an estimated cost in paise.
 * Estimates are env-driven so pricing changes never need a deploy of logic:
 *  - SARVAM_COST_PAISE_PER_MIN  — STT cost per audio-minute (unset → null)
 *  - OPENROUTER_USD_INR_PAISE   — paise per USD to convert OpenRouter's
 *    returned usage.cost (default 8800 = ₹88/USD); exact raw usage is kept
 *    in meta either way.
 * Writes are best-effort: telemetry must never break the user flow.
 */

export interface AiInvocationInput {
  userId: string
  /** Telemetry bucket; defaults to the voice pipeline. */
  feature?: 'voice_rfq' | 'voice_eval' | 'catalog_draft' | undefined
  step: 'stt' | 'parse'
  vendor: string
  status: 'ok' | 'error' | 'stub'
  latencyMs: number
  costEstPaise: number | null
  inputBytes?: number | undefined
  outputChars?: number | undefined
  requestId?: string | null | undefined
  error?: string | undefined
  meta?: Record<string, unknown> | undefined
  /** H0 (0026): agent run this call belongs to; null for standalone calls. */
  runId?: string | null | undefined
  /** H0 (0026): overrides the step-derived task class (router attribution). */
  taskClass?: AgentTaskClass | undefined
}

/** Legacy voice steps map onto the shared task-class vocabulary (ADR-008). */
const STEP_TASK_CLASS: Record<AiInvocationInput['step'], AgentTaskClass> = {
  stt: 'speech_to_text',
  parse: 'rfq_parse',
}

export async function logAiInvocation(admin: Admin, row: AiInvocationInput): Promise<void> {
  try {
    const taskClass: AgentTaskClass = row.taskClass ?? STEP_TASK_CLASS[row.step]
    const tier: AgentTier = tierFor(taskClass)
    const tokens = tokensFromUsage(row.meta)
    const { error } = await admin.from('ai_invocations').insert({
      user_id: row.userId,
      feature: row.feature ?? 'voice_rfq',
      step: row.step,
      vendor: row.vendor,
      status: row.status,
      latency_ms: row.latencyMs,
      cost_est_paise: row.costEstPaise,
      input_bytes: row.inputBytes ?? null,
      output_chars: row.outputChars ?? null,
      request_id: row.requestId ?? null,
      error: row.error ?? null,
      meta: row.meta ?? null,
      run_id: row.runId ?? null,
      task_class: taskClass,
      tier,
      input_tokens: tokens.input,
      output_tokens: tokens.output,
    })
    if (error) console.error('[ai-invocations]', error.message)
  } catch (e) {
    console.error('[ai-invocations]', e)
  }
}
