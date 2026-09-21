import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { RfqQualityDecision } from '@amclub/shared'
import { fanoutRfq } from '@/lib/rfq/fanout'

/**
 * S1.5 — the ONE release path for a deferred RFQ. Guarded on `fanout_at IS
 * NULL` so the buyer's answer, the buyer's "send as is" and the cron guard
 * racing each other produce exactly one fan-out (Postgres re-checks the WHERE
 * under the row lock; the loser updates zero rows and never calls fanoutRfq,
 * which would otherwise re-notify every matched provider). Nothing else in
 * the codebase writes `fanout_at`.
 */
export async function releaseDeferredRfq(
  admin: SupabaseClient,
  rfqId: string,
  decision: RfqQualityDecision,
  extra?: { decisionId?: string | null },
): Promise<{ released: boolean; matched: number }> {
  const now = new Date().toISOString()
  const { data, error } = await admin
    .from('rfqs')
    .update({
      fanout_at: now,
      quality_decision: decision,
      quality_decision_at: now,
      ...(extra?.decisionId !== undefined ? { quality_decision_id: extra.decisionId } : {}),
      updated_at: now,
    })
    .eq('id', rfqId)
    .is('fanout_at', null)
    .select('id')
  if (error) {
    console.error('[rfq release]', rfqId, error.message)
    return { released: false, matched: 0 }
  }
  if (!data || data.length === 0) return { released: false, matched: 0 }

  // Fan-out (match + notify). Best-effort — the RFQ is released regardless.
  let matched = 0
  try {
    ;({ matched } = await fanoutRfq(admin, rfqId))
  } catch (e) {
    console.error('[rfq release fanout]', rfqId, e)
  }
  return { released: true, matched }
}
