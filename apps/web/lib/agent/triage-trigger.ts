import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AGENT_ENABLED } from '@/lib/flags'
import { getAgentSetting, isAgentEnabledForUser } from '@/lib/agent/settings'
import { enqueueRuntimeJob } from '@/lib/agent/runtime-client'
import { countTriages, DISPUTE_TRIAGE_CAP } from '@/lib/agent/triages'

/**
 * Dispute-Triage agent trigger (S1.7). Called (a) from applyTransition right
 * after the disputes upsert on raise_dispute and (b) from the statement route
 * after the SECOND party's statement lands (a re-triage). Gates exactly as
 * maybeEnqueuePayoutDossier: AGENT_ENABLED → ops_user_id → agents_enabled
 * .dispute_triage + the ops user in the cohort → the per-dispute cap. Best
 * effort: never throws, never touches money or the dispute.
 */
export async function maybeEnqueueDisputeTriage(
  admin: SupabaseClient,
  d: { orderId: string; disputeId: string },
): Promise<{ enqueued: boolean; reason?: string }> {
  try {
    if (!AGENT_ENABLED) return { enqueued: false, reason: 'agent_disabled' }
    const opsUserId = (await getAgentSetting(admin, 'ops_user_id')) as string | null
    if (!opsUserId) return { enqueued: false, reason: 'no_ops_user' }
    if (!(await isAgentEnabledForUser(admin, 'dispute_triage', opsUserId))) return { enqueued: false, reason: 'agent_off_or_not_in_cohort' }
    if ((await countTriages(admin, d.disputeId)) >= DISPUTE_TRIAGE_CAP) return { enqueued: false, reason: 'triage_cap' }
    const r = await enqueueRuntimeJob(
      'dispute_triage',
      {
        open: { userId: opsUserId, surface: 'system', subjectType: 'dispute', subjectId: d.disputeId },
        input: { disputeId: d.disputeId, orderId: d.orderId },
      },
      { userId: opsUserId, persona: 'ops' },
    )
    if (!r.ok) return { enqueued: false, reason: r.reason ?? 'enqueue_failed' }
    return { enqueued: true }
  } catch (e) {
    console.error('[triage-trigger]', (e as Error).message)
    return { enqueued: false, reason: 'error' }
  }
}
