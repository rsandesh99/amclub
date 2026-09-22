import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { redactContactInfo, type SupportIntent, type SupportLocale, type SupportTicketStatus } from '@amclub/shared'
import { buildTicketSummaryParts, supportTicketSummarySchema } from '@amclub/agent-core'
import { boundedChatJson, BudgetExceededError } from '@/lib/agent/bounded'
import { createNotification } from '@/lib/notifications/create'
import { getAgentSetting } from '@/lib/agent/settings'
import { captureServerEvent } from '@/lib/analytics/server'
import { writeAudit } from '@/lib/audit/log'
import { inQuietHours, getSupportSettings, SUPPORT_SLA } from '@/lib/support/settings'

/**
 * S2.3 — tickets (escalations a human resolves) and the web / mobile chat
 * threads. Every write is service-role AFTER the caller proved the session
 * (the route) or the runtime credential (the admin tickets POST). While a
 * ticket is open the agent stays quiet on that conversation / thread; only
 * a human's Resolve re-enables it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SupportTicketRow {
  id: string
  user_id: string
  role: 'buyer' | 'provider'
  channel: 'whatsapp' | 'web' | 'mobile'
  conversation_id: string | null
  thread_id: string | null
  order_id: string | null
  rfq_id: string | null
  intent: string | null
  reason: string
  summary: string | null
  suggested_next: string | null
  status: SupportTicketStatus
  assigned_to: string | null
  acknowledged_at: string | null
  resolved_at: string | null
  resolved_by: string | null
  resolution_note: string | null
  run_id: string | null
  created_at: string
  updated_at: string
}

export const TICKET_COLS = 'id, user_id, role, channel, conversation_id, thread_id, order_id, rfq_id, intent, reason, summary, suggested_next, status, assigned_to, acknowledged_at, resolved_at, resolved_by, resolution_note, run_id, created_at, updated_at'

/** A short human reference for a ticket id (the user sees this in the escalated template). */
export function ticketRef(id: string): string {
  return `T-${id.slice(0, 8).toUpperCase()}`
}

// ── threads (web / mobile) ────────────────────────────────────────────────────

export interface SupportThreadRow {
  id: string
  user_id: string
  role: 'buyer' | 'provider'
  locale: string
  last_intents: SupportIntent[]
  unclear_streak: number
  open_ticket_id: string | null
}

export async function getOrCreateThread(admin: SupabaseClient, args: { userId: string; role: 'buyer' | 'provider'; locale: SupportLocale; threadId?: string | null }): Promise<SupportThreadRow> {
  if (args.threadId) {
    const { data } = await admin.from('support_threads').select('id, user_id, role, locale, last_intents, unclear_streak, open_ticket_id').eq('id', args.threadId).eq('user_id', args.userId).is('deleted_at', null).maybeSingle()
    if (data) return data as SupportThreadRow
  }
  const { data: latest } = await admin.from('support_threads').select('id, user_id, role, locale, last_intents, unclear_streak, open_ticket_id').eq('user_id', args.userId).eq('role', args.role).is('deleted_at', null).order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (latest) return latest as SupportThreadRow
  const { data, error } = await admin.from('support_threads').insert({ user_id: args.userId, role: args.role, locale: args.locale }).select('id, user_id, role, locale, last_intents, unclear_streak, open_ticket_id').single()
  if (error) throw new Error(`thread insert: ${error.message}`)
  return data as SupportThreadRow
}

export async function storeMessage(admin: SupabaseClient, args: { threadId: string; role: 'user' | 'assistant'; body: string; intent?: string | null; replyKey?: string | null; lookupRefs?: Record<string, unknown> | null; runId?: string | null }): Promise<{ id: string; redacted: boolean }> {
  const masked = args.role === 'user' ? redactContactInfo(args.body) : { text: args.body, redacted: false }
  const { data, error } = await admin.from('support_messages').insert({ thread_id: args.threadId, role: args.role, body: masked.text, redacted: masked.redacted, intent: args.intent ?? null, reply_key: args.replyKey ?? null, lookup_refs: args.lookupRefs ?? null, run_id: args.runId ?? null }).select('id').single()
  if (error) throw new Error(`message insert: ${error.message}`)
  return { id: (data as { id: string }).id, redacted: masked.redacted }
}

export async function updateThreadHistory(admin: SupabaseClient, threadId: string, patch: { intents?: SupportIntent[]; unclearStreak?: number; openTicketId?: string | null; locale?: SupportLocale }): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.intents) row['last_intents'] = patch.intents.slice(-5)
  if (patch.unclearStreak !== undefined) row['unclear_streak'] = patch.unclearStreak
  if (patch.openTicketId !== undefined) row['open_ticket_id'] = patch.openTicketId
  if (patch.locale) row['locale'] = patch.locale
  const { error } = await admin.from('support_threads').update(row).eq('id', threadId)
  if (error) console.error('[support] thread update failed', error.message)
}

export async function listThreadMessages(admin: SupabaseClient, threadId: string, limit = 50): Promise<{ id: string; role: string; body: string; intent: string | null; reply_key: string | null; created_at: string }[]> {
  const { data } = await admin.from('support_messages').select('id, role, body, intent, reply_key, created_at').eq('thread_id', threadId).order('created_at', { ascending: false }).limit(limit)
  return (((data as any[]) ?? []).reverse()) as any
}

// ── tickets ──────────────────────────────────────────────────────────────────

export interface OpenTicketArgs {
  userId: string
  role: 'buyer' | 'provider'
  channel: 'whatsapp' | 'web' | 'mobile'
  locale: SupportLocale
  conversationId?: string | null
  threadId?: string | null
  orderId?: string | null
  rfqId?: string | null
  intent?: string | null
  reason: string
  /** Oldest first; ≤ 6 are summarised. */
  transcript: { id: string; role: 'user' | 'assistant'; text: string }[]
  /** Platform facts for the summary (numbers / statuses only). */
  facts?: { order?: { order_number: string; status: string; amount: string } | null; rfq?: { title: string; status: string; quote_count: number } | null }
  runId?: string | null
}

const FALLBACK_SUMMARY = 'See the transcript — the automatic summary was not available.'

/** ONE open ticket per (user, channel): a second escalation returns the existing one. */
export async function openTicket(admin: SupabaseClient, args: OpenTicketArgs): Promise<{ ticket: SupportTicketRow; created: boolean }> {
  const { data: existing } = await admin.from('support_tickets').select(TICKET_COLS).eq('user_id', args.userId).eq('channel', args.channel).neq('status', 'resolved').is('deleted_at', null).maybeSingle()
  if (existing) return { ticket: existing as SupportTicketRow, created: false }

  let summary = FALLBACK_SUMMARY
  let suggested: string | null = null
  try {
    const parts = buildTicketSummaryParts({ ticketId: `pending-${args.userId.slice(0, 8)}`, locale: args.locale, role: args.role, channel: args.channel, order: args.facts?.order ?? null, rfq: args.facts?.rfq ?? null, reason: args.reason, transcript: args.transcript.slice(-6) })
    const res = await boundedChatJson(admin, {
      userId: args.userId,
      feature: 'support',
      taskClass: 'support_reply',
      promptId: 'support_ticket_summary',
      promptVersion: 'v1',
      schema: supportTicketSummarySchema,
      parts,
      temperature: 0.2,
      stub: () => ({ summary: `${args.role} escalated on ${args.channel} (${args.reason}); see the transcript.`, suggested_next: args.reason === 'asked_for_human' ? 'call_user' : 'check_order' }),
      meta: { reason: args.reason, channel: args.channel },
    })
    summary = res.data.summary
    suggested = res.data.suggested_next
  } catch (e) {
    if (e instanceof BudgetExceededError) console.warn('[support] ticket summary budget exceeded')
    else console.error('[support] ticket summary failed', (e as Error).message)
  }

  const { data, error } = await admin
    .from('support_tickets')
    .insert({ user_id: args.userId, role: args.role, channel: args.channel, conversation_id: args.conversationId ?? null, thread_id: args.threadId ?? null, order_id: args.orderId ?? null, rfq_id: args.rfqId ?? null, intent: args.intent ?? null, reason: args.reason, summary, suggested_next: suggested, run_id: args.runId ?? null })
    .select(TICKET_COLS)
    .single()
  if (error) {
    // the partial unique index raced: return the open one
    const { data: again } = await admin.from('support_tickets').select(TICKET_COLS).eq('user_id', args.userId).eq('channel', args.channel).neq('status', 'resolved').is('deleted_at', null).maybeSingle()
    if (again) return { ticket: again as SupportTicketRow, created: false }
    throw new Error(`ticket insert: ${error.message}`)
  }
  const ticket = data as SupportTicketRow
  if (args.threadId) await updateThreadHistory(admin, args.threadId, { openTicketId: ticket.id })
  if (args.conversationId) await admin.from('wa_conversations').update({ support_ticket_id: ticket.id }).eq('id', args.conversationId)

  const ref = ticketRef(ticket.id)
  await createNotification(admin, {
    userId: args.userId,
    kind: 'support_escalated',
    titleI18n: { en: `A person will contact you (${ref})`, hi: `एक व्यक्ति आपसे संपर्क करेगा (${ref})`, te: `ఒక వ్యక్తి మిమ్మల్ని సంప్రదిస్తారు (${ref})` },
    bodyI18n: { en: `We acknowledge within ${SUPPORT_SLA.acknowledge_hours} hours and resolve within ${SUPPORT_SLA.resolve_days} days.`, hi: `हम ${SUPPORT_SLA.acknowledge_hours} घंटे में पावती देते हैं और ${SUPPORT_SLA.resolve_days} दिन में निपटाते हैं।`, te: `మేము ${SUPPORT_SLA.acknowledge_hours} గంటల్లో స్వీకరించి ${SUPPORT_SLA.resolve_days} రోజుల్లో పరిష్కరిస్తాం.` },
    link: args.role === 'provider' ? '/partner/support' : '/app/support',
    channels: args.channel === 'whatsapp' ? ['whatsapp'] : [],
  })
  const opsUserId = (await getAgentSetting(admin, 'ops_user_id')) as string | null
  if (opsUserId) {
    const settings = await getSupportSettings(admin)
    const quiet = inQuietHours(settings.opsQuietHours)
    await createNotification(admin, {
      userId: opsUserId,
      kind: 'support_ticket_opened',
      titleI18n: { en: `Support ticket ${ref} (${args.role}, ${args.channel}): ${args.reason}`, hi: `सपोर्ट टिकट ${ref} (${args.role}, ${args.channel}): ${args.reason}` },
      bodyI18n: { en: summary, hi: summary },
      link: `/admin/support?ticket=${ticket.id}`,
      channels: quiet ? ['email'] : ['email', 'whatsapp'],
    })
  }
  captureServerEvent(args.userId, 'support_ticket_opened', { channel: args.channel, role: args.role, reason: args.reason, has_summary: summary !== FALLBACK_SUMMARY })
  return { ticket, created: true }
}

export async function getOpenTicketForThread(admin: SupabaseClient, threadId: string): Promise<SupportTicketRow | null> {
  const { data } = await admin.from('support_tickets').select(TICKET_COLS).eq('thread_id', threadId).neq('status', 'resolved').is('deleted_at', null).maybeSingle()
  return (data as SupportTicketRow | null) ?? null
}

// ── admin ────────────────────────────────────────────────────────────────────

export async function listTickets(admin: SupabaseClient, status: 'open' | 'all' = 'open'): Promise<SupportTicketRow[]> {
  let q = admin.from('support_tickets').select(TICKET_COLS).is('deleted_at', null).order('created_at', { ascending: true }).limit(200)
  if (status === 'open') q = q.neq('status', 'resolved')
  const { data } = await q
  const rows = ((data as SupportTicketRow[]) ?? [])
  return status === 'all' ? rows.sort((a, b) => (a.status === 'resolved' ? 1 : 0) - (b.status === 'resolved' ? 1 : 0) || a.created_at.localeCompare(b.created_at)) : rows
}

export async function getTicket(admin: SupabaseClient, id: string): Promise<{ ticket: SupportTicketRow; transcript: { id: string; role: string; body: string; created_at: string }[]; subject: { order?: { id: string; order_number: string; status: string } | null; rfq?: { id: string; title: string; status: string } | null } } | null> {
  const { data } = await admin.from('support_tickets').select(TICKET_COLS).eq('id', id).is('deleted_at', null).maybeSingle()
  const ticket = data as SupportTicketRow | null
  if (!ticket) return null
  let transcript: { id: string; role: string; body: string; created_at: string }[] = []
  if (ticket.thread_id) transcript = (await listThreadMessages(admin, ticket.thread_id, 50)).map((m) => ({ id: m.id, role: m.role, body: m.body, created_at: m.created_at }))
  else if (ticket.conversation_id) {
    const { data: msgs } = await admin.from('wa_messages').select('id, direction, body, created_at').eq('conversation_id', ticket.conversation_id).order('created_at', { ascending: false }).limit(50)
    transcript = (((msgs as any[]) ?? []).reverse()).map((m) => ({ id: m.id, role: m.direction === 'in' ? 'user' : 'assistant', body: redactContactInfo(String(m.body ?? '')).text, created_at: m.created_at }))
  }
  const subject: { order?: { id: string; order_number: string; status: string } | null; rfq?: { id: string; title: string; status: string } | null } = {}
  if (ticket.order_id) {
    const { data: o } = await admin.from('orders').select('id, order_number, status').eq('id', ticket.order_id).maybeSingle()
    subject.order = (o as any) ?? null
  }
  if (ticket.rfq_id) {
    const { data: r } = await admin.from('rfqs').select('id, title, status').eq('id', ticket.rfq_id).maybeSingle()
    subject.rfq = (r as any) ?? null
  }
  return { ticket, transcript, subject }
}

export type TicketAction = 'acknowledge' | 'assign' | 'resolve'

export async function actOnTicket(admin: SupabaseClient, request: Request | null, args: { id: string; action: TicketAction; adminUserId: string; note?: string | null }): Promise<{ ok: true; ticket: SupportTicketRow } | { ok: false; error: 'not_found' | 'already_resolved' | 'note_required' }> {
  const { data } = await admin.from('support_tickets').select(TICKET_COLS).eq('id', args.id).is('deleted_at', null).maybeSingle()
  const before = data as SupportTicketRow | null
  if (!before) return { ok: false, error: 'not_found' }
  if (before.status === 'resolved') return { ok: false, error: 'already_resolved' }
  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { updated_at: now }
  if (args.action === 'acknowledge') {
    patch['acknowledged_at'] = before.acknowledged_at ?? now
    patch['status'] = 'in_progress'
  } else if (args.action === 'assign') {
    patch['assigned_to'] = args.adminUserId
    patch['acknowledged_at'] = before.acknowledged_at ?? now
    patch['status'] = 'in_progress'
  } else {
    if (!args.note || !args.note.trim()) return { ok: false, error: 'note_required' }
    patch['status'] = 'resolved'
    patch['resolved_at'] = now
    patch['resolved_by'] = args.adminUserId
    patch['resolution_note'] = args.note.trim().slice(0, 1000)
    patch['acknowledged_at'] = before.acknowledged_at ?? now
  }
  const { data: after, error } = await admin.from('support_tickets').update(patch).eq('id', args.id).neq('status', 'resolved').select(TICKET_COLS).single()
  if (error || !after) return { ok: false, error: 'already_resolved' }
  const ticket = after as SupportTicketRow
  await writeAudit(admin, request, { actorId: args.adminUserId, action: `support_ticket_${args.action}`, entity: 'support_tickets', entityId: args.id, before: { status: before.status, assigned_to: before.assigned_to }, after: { status: ticket.status, assigned_to: ticket.assigned_to, resolved_at: ticket.resolved_at } })
  if (args.action === 'resolve') {
    // re-enable the agent on that conversation / thread; tell the user
    if (ticket.thread_id) await updateThreadHistory(admin, ticket.thread_id, { openTicketId: null, unclearStreak: 0 })
    if (ticket.conversation_id) await admin.from('wa_conversations').update({ support_ticket_id: null, support_unclear_streak: 0 }).eq('id', ticket.conversation_id)
    const note = ticket.resolution_note ?? ''
    await createNotification(admin, {
      userId: ticket.user_id,
      kind: 'support_resolved',
      titleI18n: { en: `Your support ticket ${ticketRef(ticket.id)} is resolved`, hi: `आपका सपोर्ट टिकट ${ticketRef(ticket.id)} निपट गया`, te: `మీ సపోర్ట్ టికెట్ ${ticketRef(ticket.id)} పరిష్కారం అయింది` },
      bodyI18n: { en: note, hi: note, te: note },
      link: ticket.role === 'provider' ? '/partner/support' : '/app/support',
      channels: ticket.channel === 'whatsapp' ? ['whatsapp'] : [],
    })
    captureServerEvent(args.adminUserId, 'support_ticket_resolved', { ticket_id: ticket.id, channel: ticket.channel, minutes_open: Math.round((Date.now() - new Date(ticket.created_at).getTime()) / 60000) })
  }
  return { ok: true, ticket }
}

export interface SupportStats {
  open: number
  in_progress: number
  median_ack_minutes: number | null
  ack_within_sla_pct: number | null
  self_serve_rate_pct: number | null
  turns_7d: number
  escalations_7d: number
  reasons: Record<string, number>
}

export async function supportStats(admin: SupabaseClient): Promise<SupportStats> {
  const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString()
  const [{ data: tickets }, { count: turns }, { data: waTurns }] = await Promise.all([
    admin.from('support_tickets').select('status, reason, created_at, acknowledged_at').is('deleted_at', null).gte('created_at', since),
    admin.from('support_messages').select('id', { count: 'exact', head: true }).eq('role', 'user').gte('created_at', since),
    admin.from('wa_messages').select('id', { count: 'exact', head: true }).eq('direction', 'in').gte('created_at', since).not('payload->support', 'is', null),
  ])
  const rows = ((tickets as any[]) ?? [])
  const acks = rows.filter((t) => t.acknowledged_at).map((t) => (new Date(t.acknowledged_at).getTime() - new Date(t.created_at).getTime()) / 60000).sort((a, b) => a - b)
  const median = acks.length ? acks[Math.floor(acks.length / 2)]! : null
  const withinSla = acks.length ? Math.round((acks.filter((m) => m <= SUPPORT_SLA.acknowledge_hours * 60).length / acks.length) * 100) : null
  const reasons: Record<string, number> = {}
  for (const t of rows) reasons[t.reason] = (reasons[t.reason] ?? 0) + 1
  const { count: openCount } = await admin.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'open').is('deleted_at', null)
  const { count: inProgress } = await admin.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'in_progress').is('deleted_at', null)
  const totalTurns = (turns ?? 0) + ((waTurns as unknown as number | null) ?? 0)
  const escalations = rows.length
  return {
    open: openCount ?? 0,
    in_progress: inProgress ?? 0,
    median_ack_minutes: median == null ? null : Math.round(median),
    ack_within_sla_pct: withinSla,
    self_serve_rate_pct: totalTurns ? Math.round(((totalTurns - escalations) / totalTurns) * 100) : null,
    turns_7d: totalTurns,
    escalations_7d: escalations,
    reasons,
  }
}
