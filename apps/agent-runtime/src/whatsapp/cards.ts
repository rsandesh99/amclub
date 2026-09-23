/**
 * Typed "no" to an open card (founder decision 2026-09-23; docs/agents/WHATSAPP.md "Typed no").
 *
 * While one of the user's agent cards is open on WhatsApp, a plain negative ("no" / "cancel" / "नहीं" / "వద్దు")
 * means "no to this card", not "leave WhatsApp". STOP / UNSUBSCRIBE and their translations always opt out — the
 * classifier (`classifyKeyword`, agent-core) decides that; this file only answers "is a card open, and whose".
 *
 * A card is open when:
 *   - Munshi: a `proposed` draft delivered on WhatsApp in the last 24 h (the same rule `routeMunshiInbound` routes by);
 *   - Support: a nudge offer — a support run on WhatsApp for this conversation parked `awaiting_confirmation`, < 24 h;
 *   - Procurement: the conversation's active session has an open proposal (`open_run_id`, the parked run; `pending` alone can be a relayed question).
 * The latest card wins (`latestOpenCard`). The "no" then goes to that agent's OWN decide job — exactly what its No
 * button does — so nothing new can be written: every path is a decline.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { latestOpenCard, type OpenWhatsAppCard } from '@amclub/agent-core'
import { procurementSessionIsActive } from '@amclub/shared'
import { isAgentEnabledForUser } from '../settings'

const CARD_WINDOW_MS = 24 * 3600 * 1000

async function munshiCard(db: SupabaseClient, userId: string, since: string): Promise<OpenWhatsAppCard | null> {
  const { data } = await db
    .from('munshi_drafts')
    .select('run_id, delivered, created_at')
    .eq('user_id', userId)
    .eq('status', 'proposed')
    .gt('created_at', since)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(5)
  const row = ((data as { run_id: string | null; delivered: Record<string, unknown> | null; created_at: string }[] | null) ?? []).find((r) => r.run_id && r.delivered && r.delivered['whatsapp'])
  return row?.run_id ? { agent: 'munshi', runId: row.run_id, at: row.created_at } : null
}

async function supportCard(db: SupabaseClient, userId: string, conversationId: string, since: string): Promise<OpenWhatsAppCard | null> {
  const { data } = await db
    .from('agent_runs')
    .select('id, created_at')
    .eq('user_id', userId)
    .eq('surface', 'whatsapp')
    .eq('status', 'awaiting_confirmation')
    .eq('subject_type', 'wa_conversation')
    .eq('subject_id', conversationId)
    .eq('meta->>agent', 'support')
    .gt('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const row = data as { id: string; created_at: string } | null
  return row ? { agent: 'support', runId: row.id, at: row.created_at } : null
}

async function procurementCard(db: SupabaseClient, userId: string, conversationId: string): Promise<OpenWhatsAppCard | null> {
  if (!(await isAgentEnabledForUser(db, 'procurement', userId))) return null
  // read the pointer on its own (0045 column): a failure costs this lookup only, never the dispatcher
  const { data: conv, error } = await db.from('wa_conversations').select('procurement_session_id').eq('id', conversationId).maybeSingle()
  const sessionId = error ? null : ((conv as { procurement_session_id?: string | null } | null)?.procurement_session_id ?? null)
  if (!sessionId) return null
  const { data: s } = await db.from('procurement_sessions').select('user_id, state, open_run_id, updated_at').eq('id', sessionId).is('deleted_at', null).maybeSingle()
  const row = s as { user_id: string; state: string; open_run_id: string | null; updated_at: string } | null
  if (!row || row.user_id !== userId || !procurementSessionIsActive(row.state) || !row.open_run_id) return null
  return { agent: 'procurement', runId: row.open_run_id, at: row.updated_at }
}

/** The card a typed "no" from this user in this conversation answers, or null (→ the S0.5 opt-out). */
export async function openWhatsAppCard(db: SupabaseClient, args: { userId: string; conversationId: string }): Promise<OpenWhatsAppCard | null> {
  const since = new Date(Date.now() - CARD_WINDOW_MS).toISOString()
  const found = await Promise.all([
    munshiCard(db, args.userId, since).catch(() => null),
    supportCard(db, args.userId, args.conversationId, since).catch(() => null),
    procurementCard(db, args.userId, args.conversationId).catch(() => null),
  ])
  return latestOpenCard(found)
}
