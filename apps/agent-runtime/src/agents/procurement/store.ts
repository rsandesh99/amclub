import type { SupabaseClient } from '@supabase/supabase-js'
import {
  PROCUREMENT_DEFAULTS,
  PROCUREMENT_TURN_BODY_MAX,
  hasProcurementScopes,
  procurementSessionIsActive,
  redactContactInfo,
  toProcurementLocale,
  type ProcurementSessionState,
} from '@amclub/shared'
import type { ProcurementPatch, ProcurementSessionView, RunAgentDeps, WhatsAppProvider } from '@amclub/agent-core'
import { isAgentEnabledForUser, readAgentSettings } from '../../settings'
import { currentPhoneDigits, phoneDigits } from '../../whatsapp/binding'

/**
 * S3.1 — the procurement runtime's store. The service role here touches ONLY agent-owned tables
 * (procurement_sessions, procurement_turns, wa_*, agent_grants reads) and the ledgers; every RFQ / quote /
 * clarification / thread read or write is an /api/v1 call under the buyer's delegated token (the agent definitions
 * in agent-core). The agent-writes audit test scans this directory.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ProcurementRuntimeDeps {
  core: RunAgentDeps
  admin: SupabaseClient
  whatsapp: WhatsAppProvider
  /** The web base URL (API + links; the pages live on the same host). */
  apiUrl: string
  agentEnabled: boolean
  tokenFor: (args: { runId: string; userId: string }) => Promise<string>
  mediaBucket: string
  runtimeSecret: string
  now?: () => Date
  capture?: (userId: string, event: string, props?: Record<string, unknown>) => void
  fetchImpl?: typeof fetch
}

export type ProcurementJobResult = { status: 'ok'; detail: Record<string, unknown> } | { status: 'failed'; error: string }

export const nowOf = (deps: ProcurementRuntimeDeps) => (deps.now ?? (() => new Date()))()

/** IST calendar date (the daily proposal cap resets at midnight IST). */
export function istDate(d: Date): string {
  return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
}

export interface ProcurementSettings {
  chaseHours: number
  ttlDays: number
  maxProposalsPerDay: number
}

export async function procurementSettings(admin: SupabaseClient): Promise<ProcurementSettings> {
  const s = await readAgentSettings(admin, ['procurement_chase_hours', 'procurement_session_ttl_days', 'procurement_max_proposals_per_day'])
  const int = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : d)
  return {
    chaseHours: int(s.procurement_chase_hours, PROCUREMENT_DEFAULTS.chaseHours, 1, 168),
    ttlDays: int(s.procurement_session_ttl_days, PROCUREMENT_DEFAULTS.sessionTtlDays, 1, 30),
    maxProposalsPerDay: int(s.procurement_max_proposals_per_day, PROCUREMENT_DEFAULTS.maxProposalsPerDay, 1, 200),
  }
}

/**
 * The union of the buyer's ACTIVE grant scopes (the token carries the same union) + whether WhatsApp is granted with
 * them. Audit M41: a WhatsApp grant counts for delivery only when it was given from the buyer's CURRENT phone.
 */
export async function buyerGrant(admin: SupabaseClient, userId: string): Promise<{ scopes: string[]; whatsapp: boolean; web: boolean }> {
  const [{ data }, phone] = await Promise.all([
    admin.from('agent_grants').select('scopes, channel, channel_identity').eq('user_id', userId).eq('persona', 'buyer').is('revoked_at', null),
    currentPhoneDigits(admin, userId),
  ])
  const rows = (data as { scopes: string[] | null; channel: string; channel_identity: string | null }[] | null) ?? []
  const scopes = [...new Set(rows.flatMap((r) => r.scopes ?? []))]
  const waHere = (r: { channel: string; channel_identity: string | null }) => r.channel === 'whatsapp' && !!phone && phoneDigits(r.channel_identity) === phone
  return { scopes, whatsapp: rows.some((r) => waHere(r) && hasProcurementScopes(r.scopes)), web: rows.some((r) => r.channel !== 'whatsapp' && hasProcurementScopes(r.scopes)) }
}

/** AGENT_ENABLED (runtime) + agents_enabled.procurement + cohort + a grant carrying the procurement scopes. */
export async function procurementAllowed(deps: ProcurementRuntimeDeps, userId: string): Promise<{ ok: boolean; reason: string | null; scopes: string[]; whatsapp: boolean }> {
  if (!deps.agentEnabled) return { ok: false, reason: 'agent_disabled', scopes: [], whatsapp: false }
  if (!(await isAgentEnabledForUser(deps.admin, 'procurement', userId))) return { ok: false, reason: 'agent_disabled', scopes: [], whatsapp: false }
  const g = await buyerGrant(deps.admin, userId)
  if (!hasProcurementScopes(g.scopes)) return { ok: false, reason: 'grant_revoked', scopes: g.scopes, whatsapp: false }
  return { ok: true, reason: null, scopes: g.scopes, whatsapp: g.whatsapp }
}

// ── sessions ─────────────────────────────────────────────────────────────────

export interface SessionRow {
  id: string
  user_id: string
  msme_id: string
  rfq_id: string | null
  root_run_id: string | null
  open_run_id: string | null
  conversation_id: string | null
  surface: 'whatsapp' | 'web' | 'mobile'
  state: ProcurementSessionState
  locale: string
  title: string | null
  draft: any
  pending: any
  labels: Record<string, string> | null
  last_seen: Record<string, unknown> | null
  proposals_today: number
  proposals_date: string | null
  last_chase_at: string | null
  expires_at: string
  created_at: string
}

const SESSION_COLS = 'id, user_id, msme_id, rfq_id, root_run_id, open_run_id, conversation_id, surface, state, locale, title, draft, pending, labels, last_seen, proposals_today, proposals_date, last_chase_at, expires_at, created_at'

export async function sessionRow(admin: SupabaseClient, id: string): Promise<SessionRow | null> {
  const { data } = await admin.from('procurement_sessions').select(SESSION_COLS).eq('id', id).is('deleted_at', null).maybeSingle()
  return (data as SessionRow | null) ?? null
}

export async function sessionByOpenRun(admin: SupabaseClient, runId: string): Promise<SessionRow | null> {
  const { data } = await admin.from('procurement_sessions').select(SESSION_COLS).eq('open_run_id', runId).is('deleted_at', null).maybeSingle()
  return (data as SessionRow | null) ?? null
}

/** The agent's view of a row: the open proposal's tool comes from its run's last confirmation_requested event. */
export async function sessionView(deps: ProcurementRuntimeDeps, row: SessionRow): Promise<ProcurementSessionView> {
  let openProposal: ProcurementSessionView['openProposal'] = null
  if (row.open_run_id) {
    const run = await deps.core.ledger.getRun(row.open_run_id)
    if (run?.status === 'awaiting_confirmation') {
      const { data: ev } = await deps.admin.from('agent_events').select('tool').eq('run_id', row.open_run_id).eq('kind', 'confirmation_requested').order('created_at', { ascending: false }).limit(1).maybeSingle()
      const tool = (ev as { tool?: string } | null)?.tool
      if (tool) openProposal = { tool, runId: row.open_run_id }
    }
  }
  return {
    id: row.id,
    state: row.state,
    rfqId: row.rfq_id,
    title: row.title,
    locale: toProcurementLocale(row.locale),
    surface: row.surface,
    labels: row.labels ?? {},
    pending: row.pending ?? null,
    draft: row.draft ?? null,
    openProposal,
    lastSeen: (row.last_seen ?? {}) as ProcurementSessionView['lastSeen'],
    lastChaseAt: row.last_chase_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

/** Open a new session (drafting) for the buyer; a WhatsApp conversation then routes here. */
export async function createSession(deps: ProcurementRuntimeDeps, args: { userId: string; msmeId: string; surface: 'whatsapp' | 'web' | 'mobile'; conversationId: string | null; locale: string }): Promise<SessionRow | null> {
  const s = await procurementSettings(deps.admin)
  const now = nowOf(deps)
  const { data, error } = await deps.admin
    .from('procurement_sessions')
    .insert({ user_id: args.userId, msme_id: args.msmeId, surface: args.surface, conversation_id: args.conversationId, state: 'drafting', locale: toProcurementLocale(args.locale), expires_at: new Date(now.getTime() + s.ttlDays * 86_400_000).toISOString() })
    .select(SESSION_COLS)
    .single()
  if (error || !data) {
    console.error('[procurement] session insert failed', error?.message)
    return null
  }
  if (args.conversationId) await deps.admin.from('wa_conversations').update({ procurement_session_id: (data as SessionRow).id }).eq('id', args.conversationId)
  return data as SessionRow
}

/**
 * Persist the fields a patch touched + the open run + the sliding TTL (a buyer turn extends it). The state machine was
 * already applied to `after` (illegal steps dropped); the update is guarded on the state it expects, so a concurrent
 * writer (the watcher closing the session) is never overwritten.
 */
export async function persistSession(deps: ProcurementRuntimeDeps, before: SessionRow, after: ProcurementSessionView, extra: { openRunId?: string | null; rootRunId?: string | null; buyerTurn?: boolean; proposed?: boolean; closeReason?: string | null; patch?: ProcurementPatch } = {}): Promise<boolean> {
  const now = nowOf(deps)
  const s = extra.buyerTurn ? await procurementSettings(deps.admin) : null
  const today = istDate(now)
  const upd: Record<string, unknown> = {
    state: after.state,
    rfq_id: after.rfqId,
    title: after.title ? after.title.slice(0, 200) : null,
    draft: after.draft,
    pending: after.pending,
    labels: after.labels,
    last_seen: after.lastSeen,
    last_chase_at: after.lastChaseAt,
  }
  if (extra.openRunId !== undefined) upd['open_run_id'] = extra.openRunId
  if (extra.rootRunId && !before.root_run_id) upd['root_run_id'] = extra.rootRunId
  if (s) upd['expires_at'] = new Date(now.getTime() + s.ttlDays * 86_400_000).toISOString()
  if (extra.proposed) {
    const count = before.proposals_date === today ? before.proposals_today : 0
    upd['proposals_today'] = count + 1
    upd['proposals_date'] = today
  }
  if (extra.closeReason !== undefined) upd['close_reason'] = extra.closeReason
  if (!procurementSessionIsActive(after.state)) upd['open_run_id'] = null
  const { data, error } = await deps.admin.from('procurement_sessions').update(upd).eq('id', before.id).eq('state', before.state).select('id')
  if (error) console.error('[procurement] session update failed', error.message)
  const ok = Array.isArray(data) && data.length > 0
  if (ok && !procurementSessionIsActive(after.state) && before.conversation_id) {
    await deps.admin.from('wa_conversations').update({ procurement_session_id: null }).eq('id', before.conversation_id).eq('procurement_session_id', before.id)
  }
  return ok
}

export function proposalsLeft(row: SessionRow, s: ProcurementSettings, now: Date): number {
  return s.maxProposalsPerDay - (row.proposals_date === istDate(now) ? row.proposals_today : 0)
}

/** Cancel a parked run (superseded / session closed / grant revoked). Never throws. */
export async function cancelParkedRun(deps: ProcurementRuntimeDeps, runId: string | null, reason: string): Promise<void> {
  if (!runId) return
  try {
    const run = await deps.core.ledger.getRun(runId)
    if (run?.status === 'awaiting_confirmation') {
      await deps.core.ledger.appendEvent({ runId, kind: 'declined', actor: 'system', payload: { reason } })
      await deps.core.ledger.transitionRun(runId, 'awaiting_confirmation', 'cancelled')
    }
  } catch {
    /* already advanced */
  }
}

// ── the web-mirror thread ────────────────────────────────────────────────────

export async function recordTurn(deps: ProcurementRuntimeDeps, args: { sessionId: string; userId: string; role: 'user' | 'agent' | 'system'; surface: 'whatsapp' | 'web' | 'mobile'; body: string | null; waMessageId?: string | null; runId?: string | null; proposal?: Record<string, unknown> | null }): Promise<string | null> {
  const body = args.body == null ? null : (args.role === 'user' ? redactContactInfo(args.body).text : args.body).slice(0, PROCUREMENT_TURN_BODY_MAX)
  const { data, error } = await deps.admin
    .from('procurement_turns')
    .insert({ session_id: args.sessionId, user_id: args.userId, role: args.role, surface: args.surface, body, wa_message_id: args.waMessageId ?? null, run_id: args.runId ?? null, proposal: args.proposal ?? null })
    .select('id')
    .single()
  if (error) console.error('[procurement] turn insert failed', error.message)
  return (data as { id: string } | null)?.id ?? null
}

/** The buyer's own earlier turns (oldest first) — the only basis a drafted clarification answer may have. */
export async function buyerTurns(admin: SupabaseClient, sessionId: string, limit = 8): Promise<{ id: string; text: string; channel: 'whatsapp' | 'support_chat' }[]> {
  const { data } = await admin.from('procurement_turns').select('id, body, surface').eq('session_id', sessionId).eq('role', 'user').is('deleted_at', null).order('created_at', { ascending: false }).limit(limit)
  return (((data as { id: string; body: string | null; surface: string }[] | null) ?? []).filter((t) => t.body).reverse()).map((t) => ({ id: t.id, text: t.body!, channel: t.surface === 'whatsapp' ? 'whatsapp' : 'support_chat' }))
}

/** Mark every card of a run resolved (the original and any re-sent one; the web mirror greys their buttons). */
export async function resolveProposalTurn(admin: SupabaseClient, runId: string, status: 'approved' | 'declined' | 'edited' | 'cancelled' | 'failed'): Promise<void> {
  const { data } = await admin.from('procurement_turns').select('id, proposal').eq('run_id', runId).eq('role', 'agent').not('proposal', 'is', null)
  for (const row of (data as { id: string; proposal: Record<string, unknown> }[] | null) ?? []) {
    if (row.proposal['status'] === 'open') await admin.from('procurement_turns').update({ proposal: { ...row.proposal, status } }).eq('id', row.id)
  }
}
