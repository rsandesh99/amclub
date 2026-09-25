import type { SupabaseClient } from '@supabase/supabase-js'
import { parseProcurementButton } from '@amclub/shared'
import { buttonPayloadOf } from '../onboarding/index'
import type { ProcurementTurnJob } from './turn'
import type { ProcurementDecideJob } from './decide'

export { runProcurementTurn, type ProcurementTurnJob } from './turn'
export { decideProcurement, finalizeProcurementRun, resumeProcurementRun, type ProcurementDecideJob } from './decide'
export { runProcurementWatch } from './watch'
export { type ProcurementRuntimeDeps } from './store'

/**
 * S3.1 — the dispatcher branch (called from whatsapp/inbound.ts). Placed with Munshi's — after the active onboarding
 * session, BEFORE the S0.5 opt-in keywords — because "yes" / "ok" / "hi" are opt-in keywords: after them a buyer's
 * typed yes to a draft would never reach the session (and would re-run the opt-in). STOP (first in the dispatcher)
 * still always wins. Routed here: a `pr:` button whose run / session belongs to this user (decision · label pick ·
 * session choice / start offer). Text / audio / image / document while the conversation's session is active is routed
 * by `whatsapp/confirmations.ts` (audit M42) with `textApproval` set only when a typed yes is bound to this session's
 * proposal (the halt of an open support ticket is applied inside the turn). Everything else falls through (the S2.3
 * support branch offers new_need → the "Shall I start a request?" button).
 */

export interface ProcurementInboundHooks {
  enqueueProcurementTurn?: (job: Omit<ProcurementTurnJob, 'kind'>) => Promise<string | null>
  enqueueProcurementDecide?: (job: Omit<ProcurementDecideJob, 'kind'>) => Promise<string | null>
}

export async function routeProcurementInbound(
  admin: SupabaseClient,
  args: { messageId: string; conversationId: string; userId: string; row: { kind: string; body: string | null; payload: Record<string, unknown> | null }; procurementSessionId: string | null },
  hooks: ProcurementInboundHooks,
): Promise<boolean> {
  if (!hooks.enqueueProcurementTurn || !hooks.enqueueProcurementDecide) return false
  const btn = parseProcurementButton(buttonPayloadOf(args.row))
  if (btn) {
    if (btn.kind === 'decision') {
      const { data } = await admin.from('agent_runs').select('id, user_id').eq('id', btn.runId).maybeSingle()
      if (!data || (data as { user_id: string }).user_id !== args.userId) return false
      await hooks.enqueueProcurementDecide({ runId: btn.runId, userId: args.userId, action: btn.action, via: 'whatsapp_button', messageId: args.messageId })
      return true
    }
    if (btn.kind === 'label') {
      const { data } = await admin.from('procurement_sessions').select('id, user_id').eq('id', btn.sessionId).maybeSingle()
      if (!data || (data as { user_id: string }).user_id !== args.userId) return false
      await hooks.enqueueProcurementTurn({ userId: args.userId, surface: 'whatsapp', sessionId: btn.sessionId, conversationId: args.conversationId, messageId: args.messageId, forced: { label: btn.label } })
      return true
    }
    // a session choice (or the start offer): re-run the ORIGINAL message, which must be this user's
    const { data: orig } = await admin.from('wa_messages').select('id, conversation_id').eq('id', btn.messageId).maybeSingle()
    if (!orig || (orig as { conversation_id: string }).conversation_id !== args.conversationId) return false
    await hooks.enqueueProcurementTurn({ userId: args.userId, surface: 'whatsapp', sessionId: args.procurementSessionId, conversationId: args.conversationId, messageId: btn.messageId, forced: { sessionChoice: btn.choice } })
    return true
  }
  // Audit M42: a message while the session is active is routed by whatsapp/confirmations.ts, which binds a typed /
  // spoken yes to at most one open proposal across Munshi, procurement and support before this session may take it.
  return false
}
