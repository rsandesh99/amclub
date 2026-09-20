import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AGENT_ENABLED } from '@/lib/flags'
import { getAgentSetting, isAgentEnabledForUser } from '@/lib/agent/settings'
import { enqueueRuntimeJob } from '@/lib/agent/runtime-client'

/**
 * Payout-Evidence agent trigger (S1.4 §4c). Called by schedulePayout AFTER the
 * payouts upsert + timeline event, only when the payout was born HELD. Four
 * gates, all of which default to "off": AGENT_ENABLED, agents_enabled
 * .payout_dossier, an ops_user_id, and that ops user in cohort_user_ids (the
 * registry rule: an agent runs only for cohort members — here the run is on
 * behalf of the ops user). Best-effort: never throws, never touches money.
 * Both order kinds arrive here (goods buyer_received also calls schedulePayout).
 */
export async function maybeEnqueuePayoutDossier(
  admin: SupabaseClient,
  order: { id: string },
  payoutId: string,
): Promise<{ enqueued: boolean; reason?: string }> {
  try {
    if (!AGENT_ENABLED) return { enqueued: false, reason: 'agent_disabled' }
    const opsUserId = (await getAgentSetting(admin, 'ops_user_id')) as string | null
    if (!opsUserId) return { enqueued: false, reason: 'no_ops_user' }
    if (!(await isAgentEnabledForUser(admin, 'payout_dossier', opsUserId))) return { enqueued: false, reason: 'agent_off_or_not_in_cohort' }
    const r = await enqueueRuntimeJob(
      'payout_dossier',
      {
        open: { userId: opsUserId, surface: 'system', subjectType: 'order', subjectId: order.id },
        input: { orderId: order.id, payoutId },
      },
      { userId: opsUserId, persona: 'ops' },
    )
    if (!r.ok) return { enqueued: false, reason: r.reason ?? 'enqueue_failed' }
    return { enqueued: true }
  } catch (e) {
    console.error('[dossier-trigger]', (e as Error).message)
    return { enqueued: false, reason: 'error' }
  }
}
