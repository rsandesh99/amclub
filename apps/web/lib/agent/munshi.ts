import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  MUNSHI_CONSENT_TEXT_VERSION,
  MUNSHI_SCOPES,
  hasMunshiScopes,
  munshiDraftSchema,
  threadReplyDraftSchema,
  type MunshiBasisRow,
  type MunshiDraft,
  type MunshiDraftKind,
  type MunshiDraftStatus,
  type ThreadReplyDraft,
} from '@amclub/shared'
import { createSupabaseLedger, munshiAskPayload, munshiQuotePayload } from '@amclub/agent-core'
import { AGENT_ENABLED } from '@/lib/flags'
import { getAgentSetting, isAgentEnabledForUser } from '@/lib/agent/settings'
import { captureServerEvent } from '@/lib/analytics/server'

/**
 * S2.2 — web-side helpers for Digital Munshi. The web owns: the enable /
 * pause / disable switches (grants), the partner tab reads (state, drafts,
 * stats), the Skip decision, the composer prefill for Edit, and the admin
 * tile. It never drafts and never submits: drafting is the runtime's
 * `munshi.scan`; every submit is the provider's own tap on the ordinary quote
 * / clarification / message route (the decision route resumes the parked
 * run). Service-role writes here touch only agent-owned tables
 * (munshi_drafts, munshi_provider_state, agent_grants) — the writes audit
 * test scans this directory.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** AGENT_ENABLED + agents_enabled.munshi + cohort — for THIS user. */
export async function isMunshiEnabledFor(admin: SupabaseClient, userId: string): Promise<boolean> {
  if (!AGENT_ENABLED) return false
  return isAgentEnabledForUser(admin, 'munshi', userId)
}

export interface MunshiSettings {
  toleranceBps: number
  maxDraftsPerDay: number
  followupHoursBeforeLapse: number
  quoteWindowHours: number | null
}

export async function getMunshiSettings(admin: SupabaseClient): Promise<MunshiSettings> {
  const [tol, max, fu, win] = await Promise.all([
    getAgentSetting(admin, 'munshi_price_tolerance_bps'),
    getAgentSetting(admin, 'munshi_max_drafts_per_day'),
    getAgentSetting(admin, 'munshi_followup_hours_before_lapse'),
    getAgentSetting(admin, 'quote_window_hours'),
  ])
  const int = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : d)
  return {
    toleranceBps: int(tol, 2500, 0, 10_000),
    maxDraftsPerDay: int(max, 20, 1, 100),
    followupHoursBeforeLapse: int(fu, 6, 1, 24),
    quoteWindowHours: typeof win === 'number' && Number.isInteger(win) && win >= 6 && win <= 168 ? win : null,
  }
}

// ── grants ───────────────────────────────────────────────────────────────────

export interface MunshiGrantRow {
  id: string
  scopes: string[]
  channel: string
  channel_identity: string | null
  consent: Record<string, unknown> | null
}

export function grantHasMunshiScopes(scopes: readonly string[] | null | undefined): boolean {
  return hasMunshiScopes(scopes)
}

/** The active provider grants for the user, by channel. */
export async function munshiGrants(admin: SupabaseClient, userId: string): Promise<{ web: MunshiGrantRow | null; whatsapp: MunshiGrantRow | null }> {
  const { data } = await admin
    .from('agent_grants')
    .select('id, scopes, channel, channel_identity, consent')
    .eq('user_id', userId)
    .eq('persona', 'provider')
    .is('revoked_at', null)
  const rows = ((data as any[]) ?? []).map((r) => ({ id: r.id as string, scopes: (r.scopes as string[] | null) ?? [], channel: r.channel as string, channel_identity: (r.channel_identity as string | null) ?? null, consent: (r.consent as Record<string, unknown> | null) ?? null }))
  return { web: rows.find((r) => r.channel === 'web') ?? null, whatsapp: rows.find((r) => r.channel === 'whatsapp') ?? null }
}

async function replaceGrant(admin: SupabaseClient, args: { userId: string; channel: 'web' | 'whatsapp'; scopes: readonly string[]; channelIdentity: string | null; consent: Record<string, unknown> }): Promise<string | null> {
  const now = new Date().toISOString()
  // Grants are immutable except revoke (S0.1): revoke the active one on (user, provider, channel), insert the new one.
  await admin.from('agent_grants').update({ revoked_at: now }).eq('user_id', args.userId).eq('persona', 'provider').eq('channel', args.channel).is('revoked_at', null)
  const { data, error } = await admin
    .from('agent_grants')
    .insert({ user_id: args.userId, persona: 'provider', scopes: [...args.scopes], channel: args.channel, channel_identity: args.channelIdentity, consent: args.consent })
    .select('id')
    .single()
  if (error) {
    console.error('[munshi] grant insert failed', error.message)
    return null
  }
  return (data as { id: string }).id
}

export interface EnableMunshiArgs {
  userId: string
  providerId: string
  locale: string
  ip: string | null
  userAgent: string | null
}

/** One consent screen, two channels: the web grant carries MUNSHI_SCOPES; an existing WhatsApp grant is widened to the same list. */
export async function enableMunshi(admin: SupabaseClient, args: EnableMunshiArgs): Promise<{ webGrantId: string | null; whatsappWidened: boolean }> {
  const at = new Date().toISOString()
  const consent = { locale: args.locale, surface: 'web', text_version: MUNSHI_CONSENT_TEXT_VERSION, feature: 'munshi', ip: args.ip, user_agent: args.userAgent, at }
  const webGrantId = await replaceGrant(admin, { userId: args.userId, channel: 'web', scopes: MUNSHI_SCOPES, channelIdentity: null, consent })
  const { whatsapp } = await munshiGrants(admin, args.userId)
  let whatsappWidened = false
  if (whatsapp && !grantHasMunshiScopes(whatsapp.scopes)) {
    const merged = [...new Set([...whatsapp.scopes, ...MUNSHI_SCOPES])]
    const id = await replaceGrant(admin, { userId: args.userId, channel: 'whatsapp', scopes: merged, channelIdentity: whatsapp.channel_identity, consent: { ...(whatsapp.consent ?? {}), munshi: consent } })
    whatsappWidened = !!id
  }
  const { error } = await admin.from('munshi_provider_state').upsert({ provider_id: args.providerId, user_id: args.userId, locale: ['en', 'hi', 'te', 'ta'].includes(args.locale) ? args.locale : 'en', paused_until: null, updated_at: at }, { onConflict: 'provider_id' })
  if (error) console.error('[munshi] state upsert failed', error.message)
  captureServerEvent(args.userId, 'munshi_enabled', { whatsapp_widened: whatsappWidened })
  return { webGrantId, whatsappWidened }
}

/** Revoke the web grant; a WhatsApp grant keeps its channel (onboarding, notifications) with scopes []. */
export async function disableMunshi(admin: SupabaseClient, args: { userId: string; providerId: string }): Promise<void> {
  const now = new Date().toISOString()
  await admin.from('agent_grants').update({ revoked_at: now }).eq('user_id', args.userId).eq('persona', 'provider').eq('channel', 'web').is('revoked_at', null)
  const { whatsapp } = await munshiGrants(admin, args.userId)
  if (whatsapp && whatsapp.scopes.length) {
    await replaceGrant(admin, { userId: args.userId, channel: 'whatsapp', scopes: [], channelIdentity: whatsapp.channel_identity, consent: { ...(whatsapp.consent ?? {}), munshi_disabled_at: now } })
  }
  const { error } = await admin.from('munshi_provider_state').update({ paused_until: null, updated_at: now }).eq('provider_id', args.providerId)
  if (error && !/Could not find/.test(error.message)) console.error('[munshi] state update failed', error.message)
  captureServerEvent(args.userId, 'munshi_disabled', {})
}

export async function pauseMunshi(admin: SupabaseClient, args: { userId: string; providerId: string; hours: number }): Promise<string> {
  const until = new Date(Date.now() + args.hours * 3600 * 1000).toISOString()
  const { error } = await admin.from('munshi_provider_state').upsert({ provider_id: args.providerId, user_id: args.userId, paused_until: until, updated_at: new Date().toISOString() }, { onConflict: 'provider_id' })
  if (error) console.error('[munshi] pause failed', error.message)
  captureServerEvent(args.userId, 'munshi_paused', { hours: args.hours })
  return until
}

// ── reads ────────────────────────────────────────────────────────────────────

export interface MunshiDraftView {
  id: string
  kind: MunshiDraftKind
  status: MunshiDraftStatus
  rfq: { id: string; title: string } | null
  quote_id: string | null
  run_id: string | null
  draft: MunshiDraft | ThreadReplyDraft
  basis: MunshiBasisRow[]
  /** The exact tool payload the run proposed — what the surface sends as `final` on approve (unchanged). */
  payload: Record<string, unknown> | null
  tool: 'submit_quote' | 'ask_clarification' | 'reply_thread' | null
  result_ref: Record<string, unknown> | null
  decision_id: string | null
  expires_at: string
  created_at: string
}

export function munshiToolFor(kind: MunshiDraftKind): MunshiDraftView['tool'] {
  return kind === 'quote' ? 'submit_quote' : kind === 'ask' ? 'ask_clarification' : kind === 'reply' ? 'reply_thread' : null
}

export function munshiPayloadFor(row: { id: string; kind: MunshiDraftKind; rfq_id: string | null; quote_id: string | null; draft: unknown }): Record<string, unknown> | null {
  if (row.kind === 'quote' || row.kind === 'ask') {
    const d = munshiDraftSchema.safeParse(row.draft)
    if (!d.success || !row.rfq_id) return null
    try {
      return row.kind === 'quote' ? munshiQuotePayload(d.data, row.rfq_id, row.id) : munshiAskPayload(d.data, row.rfq_id, row.id)
    } catch {
      return null
    }
  }
  if (row.kind === 'reply') {
    const d = threadReplyDraftSchema.safeParse(row.draft)
    if (!d.success || !row.quote_id) return null
    return { quote_id: row.quote_id, body: d.data.body, munshi_draft_id: row.id }
  }
  return null
}

function toView(r: any): MunshiDraftView {
  const kind = r.kind as MunshiDraftKind
  const draft = kind === 'reply' ? threadReplyDraftSchema.safeParse(r.draft) : munshiDraftSchema.safeParse(r.draft)
  return {
    id: r.id,
    kind,
    status: r.status,
    rfq: r.rfq ? { id: r.rfq.id, title: r.rfq.title } : null,
    quote_id: r.quote_id ?? null,
    run_id: r.run_id ?? null,
    draft: (draft.success ? draft.data : r.draft) as MunshiDraft | ThreadReplyDraft,
    basis: (r.basis as MunshiBasisRow[] | null) ?? [],
    payload: munshiPayloadFor({ id: r.id, kind, rfq_id: r.rfq_id ?? null, quote_id: r.quote_id ?? null, draft: r.draft }),
    tool: munshiToolFor(kind),
    result_ref: r.result_ref ?? null,
    decision_id: r.decision_id ?? null,
    expires_at: r.expires_at,
    created_at: r.created_at,
  }
}

const DRAFT_COLS = 'id, kind, status, rfq_id, quote_id, run_id, draft, basis, result_ref, decision_id, expires_at, created_at, rfq:rfqs(id, title)'

export async function listMunshiDrafts(admin: SupabaseClient, providerId: string, opts: { status?: 'proposed' | 'all'; limit?: number } = {}): Promise<MunshiDraftView[]> {
  let q = admin.from('munshi_drafts').select(DRAFT_COLS).eq('provider_id', providerId).is('deleted_at', null).order('created_at', { ascending: false }).limit(opts.limit ?? 50)
  if ((opts.status ?? 'proposed') === 'proposed') q = q.eq('status', 'proposed').gt('expires_at', new Date().toISOString())
  const { data, error } = await q
  if (error) {
    if (!/Could not find/.test(error.message)) console.error('[munshi] drafts read failed', error.message)
    return []
  }
  return ((data as any[]) ?? []).map(toView)
}

export async function getMunshiDraft(admin: SupabaseClient, providerId: string, draftId: string): Promise<MunshiDraftView | null> {
  const { data } = await admin.from('munshi_drafts').select(DRAFT_COLS).eq('id', draftId).eq('provider_id', providerId).is('deleted_at', null).maybeSingle()
  return data ? toView(data) : null
}

export interface MunshiWeekCounts {
  proposed: number
  approved: number
  edited: number
  skipped: number
  expired: number
  failed: number
  accepted_from_drafts: number
}

async function weekCounts(admin: SupabaseClient, providerId: string | null): Promise<MunshiWeekCounts> {
  const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString()
  let q = admin.from('munshi_drafts').select('status').gte('created_at', since).is('deleted_at', null)
  if (providerId) q = q.eq('provider_id', providerId)
  const { data } = await q
  const c: MunshiWeekCounts = { proposed: 0, approved: 0, edited: 0, skipped: 0, expired: 0, failed: 0, accepted_from_drafts: 0 }
  for (const r of (data as { status: MunshiDraftStatus }[] | null) ?? []) if (r.status in c) (c as any)[r.status] += 1
  let aq = admin.from('quotes').select('id', { count: 'exact', head: true }).not('munshi_draft_id', 'is', null).eq('status', 'accepted').gte('updated_at', since)
  if (providerId) aq = aq.eq('provider_id', providerId)
  const { count } = await aq
  c.accepted_from_drafts = count ?? 0
  return c
}

export interface MunshiStateView {
  enabled: boolean
  grant: { web: boolean; whatsapp: boolean; whatsapp_number_masked: string | null }
  paused_until: string | null
  last_scan_at: string | null
  drafts_today: number
  drafts_awaiting: number
  week: MunshiWeekCounts
  price_book_rows: number
  settings: MunshiSettings
  consent_text_version: string
}

export async function munshiStateView(admin: SupabaseClient, args: { userId: string; providerId: string }): Promise<MunshiStateView> {
  const [grants, settings, { data: state }, awaiting, week, { count: pbCount }] = await Promise.all([
    munshiGrants(admin, args.userId),
    getMunshiSettings(admin),
    admin.from('munshi_provider_state').select('paused_until, last_scan_at, drafts_today, drafts_today_date').eq('provider_id', args.providerId).maybeSingle(),
    listMunshiDrafts(admin, args.providerId, { status: 'proposed', limit: 100 }),
    weekCounts(admin, args.providerId),
    admin.from('provider_price_book').select('id', { count: 'exact', head: true }).eq('provider_id', args.providerId).is('deleted_at', null),
  ])
  const s = state as { paused_until: string | null; last_scan_at: string | null; drafts_today: number; drafts_today_date: string | null } | null
  const today = new Date().toISOString().slice(0, 10)
  const masked = grants.whatsapp?.channel_identity ? grants.whatsapp.channel_identity.replace(/^(\+?\d{2})\d+(\d{2})$/, '$1••••••$2') : null
  return {
    enabled: !!grants.web && grantHasMunshiScopes(grants.web.scopes),
    grant: { web: !!grants.web && grantHasMunshiScopes(grants.web.scopes), whatsapp: !!grants.whatsapp && grantHasMunshiScopes(grants.whatsapp.scopes), whatsapp_number_masked: masked },
    paused_until: s?.paused_until && new Date(s.paused_until) > new Date() ? s.paused_until : null,
    last_scan_at: s?.last_scan_at ?? null,
    drafts_today: s?.drafts_today_date === today ? s.drafts_today : 0,
    drafts_awaiting: awaiting.length,
    week,
    price_book_rows: pbCount ?? 0,
    settings,
    consent_text_version: MUNSHI_CONSENT_TEXT_VERSION,
  }
}

// ── the Skip decision (web / mobile) ─────────────────────────────────────────

/** Decline the parked run (declined event + cancel) and mark the draft skipped. Idempotent on a non-proposed draft. */
export async function skipMunshiDraft(admin: SupabaseClient, args: { userId: string; providerId: string; draftId: string; via: 'web' | 'mobile' }): Promise<{ ok: true; status: MunshiDraftStatus } | { ok: false; error: 'not_found' }> {
  const { data } = await admin.from('munshi_drafts').select('id, status, run_id, kind').eq('id', args.draftId).eq('provider_id', args.providerId).is('deleted_at', null).maybeSingle()
  const row = data as { id: string; status: MunshiDraftStatus; run_id: string | null; kind: MunshiDraftKind } | null
  if (!row) return { ok: false, error: 'not_found' }
  if (row.status !== 'proposed') return { ok: true, status: row.status }
  const now = new Date().toISOString()
  if (row.run_id) {
    const ledger = createSupabaseLedger(admin)
    const run = await ledger.getRun(row.run_id)
    if (run?.status === 'awaiting_confirmation') {
      try {
        await ledger.appendEvent({ runId: row.run_id, kind: 'declined', tool: munshiToolFor(row.kind), actor: 'user', payload: { reason: 'skipped', via: args.via } })
        await ledger.transitionRun(row.run_id, 'awaiting_confirmation', 'cancelled')
      } catch (e) {
        console.warn('[munshi] skip: run already advanced', (e as Error).message)
      }
    }
  }
  const { error } = await admin.from('munshi_drafts').update({ status: 'skipped', result_ref: { skipped_via: args.via }, updated_at: now }).eq('id', row.id).eq('status', 'proposed')
  if (error) console.error('[munshi] skip update failed', error.message)
  captureServerEvent(args.userId, 'munshi_draft_decided', { via: args.via, outcome: 'skipped', kind: row.kind })
  return { ok: true, status: 'skipped' }
}

// ── the composer prefill (Edit) ──────────────────────────────────────────────

export interface MunshiComposerInitial {
  pricePaise: number
  deliveryDays: number
  scope: string
  gstIncluded: boolean | null
  transportIncluded: boolean | null
  validUntil: string | null
  advancePercent: number | null
}

/** A proposed quote draft of this provider → the composer's initial values. null for anything else. */
export async function munshiDraftForComposer(admin: SupabaseClient, args: { providerId: string; draftId: string; rfqId: string }): Promise<{ draftId: string; initial: MunshiComposerInitial } | null> {
  const view = await getMunshiDraft(admin, args.providerId, args.draftId)
  if (!view || view.kind !== 'quote' || (view.status !== 'proposed' && view.status !== 'edited') || view.rfq?.id !== args.rfqId) return null
  const d = view.draft as MunshiDraft
  if (!d.quote) return null
  return {
    draftId: view.id,
    initial: { pricePaise: d.quote.price_paise, deliveryDays: d.quote.delivery_days, scope: d.quote.scope, gstIncluded: d.quote.gst_included, transportIncluded: d.quote.transport_included, validUntil: d.quote.valid_until, advancePercent: d.quote.advance_percent },
  }
}

// ── admin tile ───────────────────────────────────────────────────────────────

export interface MunshiAdminStats {
  week: MunshiWeekCounts
  providers_enabled: number
  /** The Phase 2 exit metric: % of providers with an accepted quote in the last 30 days whose accepted quote came from a Munshi draft. */
  exit_metric_pct: number | null
  cost_per_approved_paise: number | null
}

export async function munshiAdminStats(admin: SupabaseClient): Promise<MunshiAdminStats> {
  const since30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString()
  const [week, { data: grants }, { data: accepted }, { data: approvedCost }] = await Promise.all([
    weekCounts(admin, null),
    admin.from('agent_grants').select('user_id, scopes').eq('persona', 'provider').eq('channel', 'web').is('revoked_at', null),
    admin.from('quotes').select('provider_id, munshi_draft_id').eq('status', 'accepted').gte('updated_at', since30),
    admin.from('munshi_drafts').select('model_cost_paise').eq('status', 'approved').gte('created_at', since30),
  ])
  const enabled = new Set(((grants as any[]) ?? []).filter((g) => grantHasMunshiScopes(g.scopes)).map((g) => g.user_id)).size
  const byProvider = new Map<string, boolean>()
  for (const q of (accepted as { provider_id: string; munshi_draft_id: string | null }[] | null) ?? []) byProvider.set(q.provider_id, (byProvider.get(q.provider_id) ?? false) || !!q.munshi_draft_id)
  const active = byProvider.size
  const withMunshi = [...byProvider.values()].filter(Boolean).length
  const costs = (approvedCost as { model_cost_paise: number }[] | null) ?? []
  const total = costs.reduce((a, c) => a + (c.model_cost_paise ?? 0), 0)
  return {
    week,
    providers_enabled: enabled,
    exit_metric_pct: active ? Math.round((withMunshi / active) * 100) : null,
    cost_per_approved_paise: costs.length ? Math.round(total / costs.length) : null,
  }
}
