import 'server-only'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  PROCUREMENT_CONSENT_TEXT_VERSION,
  PROCUREMENT_DEFAULTS,
  PROCUREMENT_SCOPES,
  hasProcurementScopes,
  procurementSessionIsActive,
  redactContactInfo,
  toProcurementLocale,
  PROCUREMENT_TURN_BODY_MAX,
  QUOTE_STATUS,
  type OrderStatus,
} from '@amclub/shared'
import { AGENT_ENABLED } from '@/lib/flags'
import { agentApiGate } from '@/lib/agent/gate'
import { isAgentEnabledForUser, getAgentSetting } from '@/lib/agent/settings'
import { requireNotDelegated } from '@/lib/agent/scope'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { captureServerEvent } from '@/lib/analytics/server'

/**
 * S3.1 — web-side helpers for the Buyer Procurement Agent (built dark; enablement is the DESIGN §8.2 V1.5→V2 gate +
 * a §8.1 mini-PRD). The web owns: the enable / disable switches (grants; one consent screen widens an existing
 * WhatsApp grant, as Munshi), the assistant mirror (sessions + turns, read under the buyer's OWN session — RLS owner
 * read), the composer (stores the buyer's turn and asks the runtime to run the SAME turn engine as WhatsApp), the
 * decision tap (the runtime's decide job — one decision path), and the admin tile. It never drafts, never proposes
 * and never calls checkout. Service-role writes here touch only agent-owned tables (agent_grants,
 * procurement_sessions, procurement_turns) — the agent-writes audit scans this directory.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const PROCUREMENT_NO_STORE = { 'Cache-Control': 'private, no-store' }

/** AGENT_ENABLED + agents_enabled.procurement + cohort — for THIS user. */
export async function isProcurementEnabledFor(admin: SupabaseClient, userId: string): Promise<boolean> {
  if (!AGENT_ENABLED) return false
  return isAgentEnabledForUser(admin, 'procurement', userId)
}

export type ProcurementRouteContext =
  | { error: NextResponse }
  | { error?: undefined; admin: SupabaseClient; supabase: SupabaseClient; userId: string; msmeId: string }

/**
 * The prologue of every /api/v1/agent/procurement/* route: the flag gate (404 dark), a buyer SESSION (never a
 * delegated token — these are the buyer's own switches and taps), the per-user enablement (404 otherwise), and a live
 * buyer identity (a suspended buyer has no msmeId — PR #15).
 */
export async function procurementRouteContext(route: string): Promise<ProcurementRouteContext> {
  const gate = agentApiGate()
  if (gate) return { error: gate }
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const delegated = await requireNotDelegated(route)
  if (delegated) return { error: delegated }
  const admin = await createAdminClient()
  if (!(await isProcurementEnabledFor(admin, userId))) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  const actor = await resolveActor(admin, userId)
  if (!actor.msmeId) return { error: NextResponse.json({ error: 'not_a_buyer' }, { status: 403 }) }
  return { admin, supabase: supabase as unknown as SupabaseClient, userId, msmeId: actor.msmeId }
}

// ── grants ───────────────────────────────────────────────────────────────────

interface GrantRow { id: string; scopes: string[]; channel: string; channel_identity: string | null; consent: Record<string, unknown> | null }

export async function procurementGrants(admin: SupabaseClient, userId: string): Promise<{ web: GrantRow | null; whatsapp: GrantRow | null }> {
  const { data } = await admin.from('agent_grants').select('id, scopes, channel, channel_identity, consent').eq('user_id', userId).eq('persona', 'buyer').is('revoked_at', null)
  const rows = ((data as any[]) ?? []).map((r) => ({ id: r.id as string, scopes: (r.scopes as string[] | null) ?? [], channel: r.channel as string, channel_identity: (r.channel_identity as string | null) ?? null, consent: (r.consent as Record<string, unknown> | null) ?? null }))
  return { web: rows.find((r) => r.channel === 'web') ?? null, whatsapp: rows.find((r) => r.channel === 'whatsapp') ?? null }
}

async function replaceGrant(admin: SupabaseClient, args: { userId: string; channel: 'web' | 'whatsapp'; scopes: readonly string[]; channelIdentity: string | null; consent: Record<string, unknown> }): Promise<string | null> {
  // Grants are immutable except revoke (S0.1): revoke the active one on (user, buyer, channel), insert the new one.
  await admin.from('agent_grants').update({ revoked_at: new Date().toISOString() }).eq('user_id', args.userId).eq('persona', 'buyer').eq('channel', args.channel).is('revoked_at', null)
  const { data, error } = await admin.from('agent_grants').insert({ user_id: args.userId, persona: 'buyer', scopes: [...args.scopes], channel: args.channel, channel_identity: args.channelIdentity, consent: args.consent }).select('id').single()
  if (error) {
    console.error('[procurement] grant insert failed', error.message)
    return null
  }
  return (data as { id: string }).id
}

/** One consent screen, two channels: the web grant carries PROCUREMENT_SCOPES (never accept_quote / place_order); an existing WhatsApp grant is widened. */
export async function enableProcurement(admin: SupabaseClient, args: { userId: string; locale: string; ip: string | null; userAgent: string | null }): Promise<{ webGrantId: string | null; whatsappWidened: boolean }> {
  const consent = { locale: toProcurementLocale(args.locale), surface: 'web', text_version: PROCUREMENT_CONSENT_TEXT_VERSION, feature: 'procurement', ip: args.ip, user_agent: args.userAgent, at: new Date().toISOString() }
  const webGrantId = await replaceGrant(admin, { userId: args.userId, channel: 'web', scopes: PROCUREMENT_SCOPES, channelIdentity: null, consent })
  const { whatsapp } = await procurementGrants(admin, args.userId)
  let whatsappWidened = false
  if (whatsapp && !hasProcurementScopes(whatsapp.scopes)) {
    const merged = [...new Set([...whatsapp.scopes, ...PROCUREMENT_SCOPES])]
    whatsappWidened = !!(await replaceGrant(admin, { userId: args.userId, channel: 'whatsapp', scopes: merged, channelIdentity: whatsapp.channel_identity, consent: { ...(whatsapp.consent ?? {}), procurement: consent } }))
  }
  captureServerEvent(args.userId, 'procurement_enabled', { whatsapp_widened: whatsappWidened })
  return { webGrantId, whatsappWidened }
}

/** Revoke the web grant; the WhatsApp grant keeps its channel (support, notifications) minus the procurement scopes. The next watch tick closes open sessions (failed, grant_revoked) and sends nothing. */
export async function disableProcurement(admin: SupabaseClient, args: { userId: string }): Promise<void> {
  const now = new Date().toISOString()
  await admin.from('agent_grants').update({ revoked_at: now }).eq('user_id', args.userId).eq('persona', 'buyer').eq('channel', 'web').is('revoked_at', null)
  const { whatsapp } = await procurementGrants(admin, args.userId)
  if (whatsapp && whatsapp.scopes.some((s) => (PROCUREMENT_SCOPES as readonly string[]).includes(s))) {
    const kept = whatsapp.scopes.filter((s) => !(PROCUREMENT_SCOPES as readonly string[]).includes(s))
    await replaceGrant(admin, { userId: args.userId, channel: 'whatsapp', scopes: kept, channelIdentity: whatsapp.channel_identity, consent: { ...(whatsapp.consent ?? {}), procurement_disabled_at: now } })
  }
  captureServerEvent(args.userId, 'procurement_disabled', {})
}

export interface ProcurementStateView {
  enabled: boolean
  whatsapp: boolean
  consent_text_version: string
  sessions: ProcurementSessionListItem[]
}

export interface ProcurementSessionListItem {
  id: string
  state: string
  active: boolean
  title: string | null
  rfq_id: string | null
  surface: string
  open_run_id: string | null
  updated_at: string
}

/** The buyer's own sessions — read under their SESSION (RLS owner read), never the service role. */
export async function listProcurementSessions(supabase: SupabaseClient, userId: string, limit = 20): Promise<ProcurementSessionListItem[]> {
  const { data } = await supabase.from('procurement_sessions').select('id, state, title, rfq_id, surface, open_run_id, updated_at').eq('user_id', userId).order('updated_at', { ascending: false }).limit(limit)
  return ((data as any[]) ?? []).map((r) => ({ id: r.id, state: r.state, active: procurementSessionIsActive(r.state), title: r.title ?? null, rfq_id: r.rfq_id ?? null, surface: r.surface, open_run_id: r.open_run_id ?? null, updated_at: r.updated_at }))
}

export async function procurementStateView(admin: SupabaseClient, supabase: SupabaseClient, userId: string): Promise<ProcurementStateView> {
  const g = await procurementGrants(admin, userId)
  return {
    enabled: !!g.web && hasProcurementScopes(g.web.scopes),
    whatsapp: !!g.whatsapp && hasProcurementScopes(g.whatsapp.scopes),
    consent_text_version: PROCUREMENT_CONSENT_TEXT_VERSION,
    sessions: await listProcurementSessions(supabase, userId),
  }
}

export interface ProcurementTurnView {
  id: string
  role: 'user' | 'agent' | 'system'
  surface: string
  body: string | null
  run_id: string | null
  proposal: { tool?: string; status?: string; edit?: boolean; labels?: string[]; key?: string; session_choice?: boolean } | null
  created_at: string
}

/** One session's thread (oldest first), under the buyer's session (RLS). */
export async function procurementThread(supabase: SupabaseClient, sessionId: string, limit = 80): Promise<{ session: ProcurementSessionListItem | null; turns: ProcurementTurnView[] }> {
  const { data: s } = await supabase.from('procurement_sessions').select('id, state, title, rfq_id, surface, open_run_id, updated_at').eq('id', sessionId).maybeSingle()
  if (!s) return { session: null, turns: [] }
  const { data } = await supabase.from('procurement_turns').select('id, role, surface, body, run_id, proposal, created_at').eq('session_id', sessionId).order('created_at', { ascending: true }).limit(limit)
  const r = s as any
  return {
    session: { id: r.id, state: r.state, active: procurementSessionIsActive(r.state), title: r.title ?? null, rfq_id: r.rfq_id ?? null, surface: r.surface, open_run_id: r.open_run_id ?? null, updated_at: r.updated_at },
    turns: ((data as any[]) ?? []).map((t) => ({ id: t.id, role: t.role, surface: t.surface, body: t.body ?? null, run_id: t.run_id ?? null, proposal: t.proposal ?? null, created_at: t.created_at })),
  }
}

/**
 * The composer: store the buyer's turn (masked) in the given ACTIVE session, or a fresh web session. The runtime then
 * runs the SAME turn engine as WhatsApp. Service role after the session + ownership check (agent-owned tables only).
 */
export async function storeComposerTurn(admin: SupabaseClient, args: { userId: string; msmeId: string; sessionId: string | null; text: string; surface: 'web' | 'mobile'; locale: string }): Promise<{ sessionId: string; turnId: string } | { error: string; status: number }> {
  let sessionId = args.sessionId
  if (sessionId) {
    const { data: s } = await admin.from('procurement_sessions').select('id, user_id, state').eq('id', sessionId).is('deleted_at', null).maybeSingle()
    if (!s || (s as { user_id: string }).user_id !== args.userId) return { error: 'Not found', status: 404 }
    if (!procurementSessionIsActive((s as { state: string }).state)) sessionId = null
  }
  if (!sessionId) {
    const ttl = await getAgentSetting(admin, 'procurement_session_ttl_days')
    const days = typeof ttl === 'number' && ttl >= 1 && ttl <= 30 ? ttl : PROCUREMENT_DEFAULTS.sessionTtlDays
    const { data, error } = await admin.from('procurement_sessions').insert({ user_id: args.userId, msme_id: args.msmeId, surface: args.surface, state: 'drafting', locale: toProcurementLocale(args.locale), expires_at: new Date(Date.now() + days * 86_400_000).toISOString() }).select('id').single()
    if (error || !data) return { error: 'session_insert_failed', status: 500 }
    sessionId = (data as { id: string }).id
  }
  const body = redactContactInfo(args.text).text.slice(0, PROCUREMENT_TURN_BODY_MAX)
  const { data: t, error } = await admin.from('procurement_turns').insert({ session_id: sessionId, user_id: args.userId, role: 'user', surface: args.surface, body }).select('id').single()
  if (error || !t) return { error: 'turn_insert_failed', status: 500 }
  return { sessionId, turnId: (t as { id: string }).id }
}

/** The ?pay=<quote>&d=<decision> deep link: valid ONLY when the decision is this buyer's approved choose_quote for this RFQ + quote. */
export async function verifyChooseDecision(admin: SupabaseClient, args: { userId: string; rfqId: string; quoteId: string; decisionId: string }): Promise<boolean> {
  const uuid = /^[0-9a-f-]{36}$/i
  if (!uuid.test(args.quoteId) || !uuid.test(args.decisionId)) return false
  const { data } = await admin.from('ai_decisions').select('id, tool, decided_by, final').eq('id', args.decisionId).maybeSingle()
  const d = data as { tool: string | null; decided_by: string | null; final: Record<string, unknown> | null } | null
  return !!d && d.tool === 'choose_quote' && d.decided_by === args.userId && d.final?.['quote_id'] === args.quoteId && d.final?.['rfq_id'] === args.rfqId
}

// ── the admin tile ───────────────────────────────────────────────────────────

const ORDER_DONE: OrderStatus[] = ['completed', 'reviewed']

export interface ProcurementStats {
  sessions_active: number
  sessions_total: number
  proposals: { approved: number; edited: number; declined: number; open: number }
  by_tool: Record<string, number>
  rfqs_created: number
  orders_from_sessions: number
  cost_paise: number
  cost_per_completed_order_paise: number | null
}

export async function procurementStats(admin: SupabaseClient): Promise<ProcurementStats> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const [{ data: sessions }, { data: turns }, { data: runs }] = await Promise.all([
    admin.from('procurement_sessions').select('id, state, rfq_id').is('deleted_at', null).gte('created_at', since).limit(5000),
    admin.from('procurement_turns').select('proposal').eq('role', 'agent').not('proposal', 'is', null).gte('created_at', since).limit(20000),
    admin.from('agent_runs').select('cost_est_paise, meta').gte('created_at', since).limit(20000),
  ])
  const ss = (sessions as { id: string; state: string; rfq_id: string | null }[] | null) ?? []
  const proposals = { approved: 0, edited: 0, declined: 0, open: 0 }
  const byTool: Record<string, number> = {}
  for (const t of ((turns as { proposal: { tool?: string; status?: string; run_id?: string } | null }[] | null) ?? [])) {
    const p = t.proposal
    if (!p?.tool || !p.run_id) continue
    byTool[p.tool] = (byTool[p.tool] ?? 0) + 1
    if (p.status === 'approved') proposals.approved++
    else if (p.status === 'edited') proposals.edited++
    else if (p.status === 'declined' || p.status === 'cancelled') proposals.declined++
    else if (p.status === 'open') proposals.open++
  }
  const rfqIds = [...new Set(ss.map((s) => s.rfq_id).filter(Boolean))] as string[]
  let orders = 0
  if (rfqIds.length) {
    // orders link to the accepted quote (orders.quote_id), not to the request
    const { data: qs } = await admin.from('quotes').select('id').in('rfq_id', rfqIds.slice(0, 1000)).eq('status', QUOTE_STATUS.accepted)
    const quoteIds = ((qs as { id: string }[] | null) ?? []).map((q) => q.id)
    if (quoteIds.length) {
      const { count } = await admin.from('orders').select('id', { count: 'exact', head: true }).in('quote_id', quoteIds).in('status', ORDER_DONE)
      orders = count ?? 0
    }
  }
  const cost = ((runs as { cost_est_paise: number | null; meta: Record<string, unknown> | null }[] | null) ?? []).filter((r) => r.meta?.['agent'] === 'procurement').reduce((a, r) => a + Number(r.cost_est_paise ?? 0), 0)
  return {
    sessions_active: ss.filter((s) => procurementSessionIsActive(s.state)).length,
    sessions_total: ss.length,
    proposals,
    by_tool: byTool,
    rfqs_created: rfqIds.length,
    orders_from_sessions: orders,
    cost_paise: cost,
    cost_per_completed_order_paise: orders ? Math.round(cost / orders) : null,
  }
}
