import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'

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
}

export function estimateSttCostPaise(durationMs: number, stub: boolean): number | null {
  if (stub) return 0
  const perMin = Number(process.env['SARVAM_COST_PAISE_PER_MIN'] ?? '')
  if (!Number.isFinite(perMin) || perMin <= 0) return null
  return Math.ceil((durationMs / 60_000) * perMin)
}

export function estimateParseCostPaise(
  usage: Record<string, unknown> | undefined,
  stub: boolean,
): number | null {
  if (stub) return 0
  const usd = typeof usage?.['cost'] === 'number' ? (usage['cost'] as number) : null
  if (usd === null) return null
  const paisePerUsd = Number(process.env['OPENROUTER_USD_INR_PAISE'] ?? '8800')
  return Math.ceil(usd * paisePerUsd)
}

export async function logAiInvocation(admin: Admin, row: AiInvocationInput): Promise<void> {
  try {
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
    })
    if (error) console.error('[ai-invocations]', error.message)
  } catch (e) {
    console.error('[ai-invocations]', e)
  }
}
