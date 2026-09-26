import type { SupabaseClient } from '@supabase/supabase-js'
import {
  WA_HELP_CONTACT,
  WA_LANGUAGE_NAMES,
  WA_MENU_KNOWN,
  WA_MENU_UNKNOWN,
  WA_PAYLOAD_START,
  redactContactInfo,
  statusLabel,
  ticketRefFromId,
  waCopy,
  waLanguageRows,
  waMenuRows,
  type WaCopyKey,
  type WaLocale,
  type WaMenuItem,
} from '@amclub/shared'
import type { sendSystem } from './outbound'
import { isMissingSchemaError, logMissingOnce } from './consent'

/**
 * ADR-030 §2 / PRD W1 — the HELP menu for everyone, with no model. A greeting, HELP / MENU / "?", or any text from a
 * person the Support agent does not serve gets a list: Track my order · My requests · Talk to a person · Language ·
 * Stop messages. A number that is not an AMClub account gets Language · How to sign up · Talk to a person · Stop.
 * Every line is fixed copy (`@amclub/shared` whatsapp-copy, en / hi / te / ta). Account reads are the bound user's own
 * rows, read on the service role and scoped to that user id (the conversation was re-derived from users.phone first).
 *
 * The service role here writes only agent-owned / WhatsApp tables (wa_conversations, support_tickets, dpdp_requests,
 * wa_messages) plus the user's own `users.preferred_locale` when they change language (agent-writes audit: the one
 * column exception).
 */

export type SendSystemFn = typeof sendSystem

export interface WaTurn {
  db: SupabaseClient
  send: SendSystemFn
  conv: { id: string; phone_e164: string; user_id: string | null }
  locale: WaLocale
  /** wa_messages.id of the inbound message being answered (the idempotency keys hang off it). */
  messageId: string
  now: Date
  capture: (distinctId: string, event: string, props?: Record<string, unknown>) => void
}

/** Never a phone number: the user id, or the conversation for a number that is not an account. */
export function distinctIdOf(turn: Pick<WaTurn, 'conv'>): string {
  return turn.conv.user_id ?? `wa_conv:${turn.conv.id}`
}

/** A reply to the person's own message (service, inside the window): purpose transactional, initiation reply. */
export async function replyWith(turn: WaTurn, kind: string, tag: string, body: { text: string; buttons?: Array<{ id: string; title: string }>; values?: Record<string, string | null> }): Promise<void> {
  try {
    await turn.send(turn.conv, kind, turn.locale, {
      idempotencyKey: `${turn.messageId}:sys:${tag}`,
      text: body.text,
      ...(body.buttons ? { buttons: body.buttons } : {}),
      ...(body.values ? { values: body.values } : {}),
      purpose: 'transactional',
      initiation: 'reply',
    })
  } catch (e) {
    // a send failure never fails the job (the message is stored; the ledger row carries the error)
    console.warn('[wa] system reply failed', kind, (e as Error).message)
  }
}

/** The public web app, in the person's language (next-intl: en has no prefix). */
export function publicUrl(path: string, locale: WaLocale): string {
  const base = (process.env['NEXT_PUBLIC_APP_URL'] ?? process.env['API_URL'] ?? 'https://amclub.in').replace(/\/$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${base}${locale === 'en' ? '' : `/${locale}`}${p}`
}

/** Remember that an automatic reply went out (the dispatcher spaces unsolicited menus / holding replies on it). */
async function markAutoReply(turn: WaTurn): Promise<void> {
  await turn.db.from('wa_conversations').update({ last_holding_reply_at: turn.now.toISOString() }).eq('id', turn.conv.id)
}

export function autoReplyDue(lastAt: string | null | undefined, now: Date, gapMs: number): boolean {
  const last = lastAt ? new Date(lastAt).getTime() : 0
  return !Number.isFinite(last) || now.getTime() - last >= gapMs
}

// ── the menu ─────────────────────────────────────────────────────────────────

export function menuItemsFor(known: boolean): readonly WaMenuItem[] {
  return known ? WA_MENU_KNOWN : WA_MENU_UNKNOWN
}

export async function sendMenu(turn: WaTurn, via: 'keyword' | 'greeting' | 'button' | 'text' | 'join'): Promise<void> {
  const known = !!turn.conv.user_id
  await replyWith(turn, 'wa_menu', 'menu', { text: waCopy(known ? 'menu_intro' : 'menu_intro_unknown', turn.locale), buttons: waMenuRows(menuItemsFor(known), turn.locale) })
  await markAutoReply(turn)
  turn.capture(distinctIdOf(turn), 'wa_menu_shown', { known, via, locale: turn.locale })
}

/** "Thanks — reply MENU" for what the runtime cannot answer (a sticker, a photo with no agent to take it). */
export async function holdingReply(turn: WaTurn): Promise<void> {
  await replyWith(turn, 'wa_holding_reply', 'holding', { text: waCopy('holding', turn.locale) })
  await markAutoReply(turn)
}

/**
 * A menu row tapped (`wa:menu:<item>`). `stop` is returned to the dispatcher (it owns consent); everything else is
 * answered here. Account rows on an unknown number fall back to the unknown-number menu.
 */
export async function runMenuItem(turn: WaTurn, item: WaMenuItem): Promise<'handled' | 'stop'> {
  if (item === 'stop') return 'stop'
  turn.capture(distinctIdOf(turn), 'wa_menu_item', { item, known: !!turn.conv.user_id })
  switch (item) {
    case 'open':
      await sendMenu(turn, 'button')
      return 'handled'
    case 'track':
      if (!turn.conv.user_id) await sendMenu(turn, 'button')
      else await trackOrders(turn, turn.conv.user_id)
      return 'handled'
    case 'requests':
      if (!turn.conv.user_id) await sendMenu(turn, 'button')
      else await myRequests(turn, turn.conv.user_id)
      return 'handled'
    case 'human':
      await talkToPerson(turn, 'human')
      return 'handled'
    case 'language':
      await sendLanguageList(turn)
      return 'handled'
    case 'signup':
      await replyWith(turn, 'wa_signup_info', 'signup', { text: waCopy('signup_info', turn.locale, { url: publicUrl('/signup', turn.locale) }) })
      return 'handled'
  }
}

// ── account lines ────────────────────────────────────────────────────────────

async function profilesOf(db: SupabaseClient, userId: string): Promise<{ msmeId: string | null; providerId: string | null }> {
  const [{ data: m }, { data: p }] = await Promise.all([
    db.from('msme_profiles').select('id').eq('user_id', userId).maybeSingle(),
    db.from('provider_profiles').select('id').eq('user_id', userId).maybeSingle(),
  ])
  return { msmeId: (m as { id: string } | null)?.id ?? null, providerId: (p as { id: string } | null)?.id ?? null }
}

interface OrderLine { order_number: string; status: string; created_at: string }

/** The user's latest 3 orders, as buyer and / or provider (their own rows only). */
export async function latestOrders(db: SupabaseClient, userId: string): Promise<{ lines: OrderLine[]; asBuyer: boolean }> {
  const { msmeId, providerId } = await profilesOf(db, userId)
  const reads: Array<PromiseLike<{ data: unknown }>> = []
  if (msmeId) reads.push(db.from('orders').select('order_number, status, created_at').eq('msme_id', msmeId).is('deleted_at', null).order('created_at', { ascending: false }).limit(3))
  if (providerId) reads.push(db.from('orders').select('order_number, status, created_at').eq('provider_id', providerId).is('deleted_at', null).order('created_at', { ascending: false }).limit(3))
  const rows = (await Promise.all(reads)).flatMap((r) => ((r.data as OrderLine[] | null) ?? []))
  const seen = new Set<string>()
  const lines = rows
    .filter((o) => (seen.has(o.order_number) ? false : (seen.add(o.order_number), true)))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 3)
  return { lines, asBuyer: !!msmeId }
}

export async function trackOrders(turn: WaTurn, userId: string): Promise<void> {
  const { lines, asBuyer } = await latestOrders(turn.db, userId)
  const l = turn.locale
  const text = lines.length
    ? [waCopy('track_header', l), ...lines.map((o) => waCopy('track_line', l, { order_number: o.order_number, status: statusLabel('order', o.status, l) })), '', waCopy('track_footer', l, { url: publicUrl(asBuyer ? '/app/orders' : '/partner/orders', l) })].join('\n')
    : waCopy('track_none', l)
  await replyWith(turn, 'wa_track_orders', 'track', { text })
}

interface RfqLine { title: string; status: string; created_at: string }

/** The buyer's latest 3 requests; a provider-only account sees the latest 3 requests matched to them. */
export async function latestRequests(db: SupabaseClient, userId: string): Promise<{ lines: RfqLine[]; asBuyer: boolean }> {
  const { msmeId, providerId } = await profilesOf(db, userId)
  if (msmeId) {
    const { data } = await db.from('rfqs').select('title, status, created_at').eq('msme_id', msmeId).is('deleted_at', null).order('created_at', { ascending: false }).limit(3)
    return { lines: (data as RfqLine[] | null) ?? [], asBuyer: true }
  }
  if (!providerId) return { lines: [], asBuyer: false }
  const { data: m } = await db.from('rfq_matches').select('rfq_id, notified_at').eq('provider_id', providerId).order('notified_at', { ascending: false }).limit(3)
  const ids = ((m as { rfq_id: string }[] | null) ?? []).map((x) => x.rfq_id)
  if (!ids.length) return { lines: [], asBuyer: false }
  const { data } = await db.from('rfqs').select('id, title, status, created_at').in('id', ids).is('deleted_at', null)
  const byId = new Map(((data as Array<RfqLine & { id: string }> | null) ?? []).map((r) => [r.id, r]))
  return { lines: ids.map((id) => byId.get(id)).filter((r): r is RfqLine & { id: string } => !!r), asBuyer: false }
}

export async function myRequests(turn: WaTurn, userId: string): Promise<void> {
  const { lines, asBuyer } = await latestRequests(turn.db, userId)
  const l = turn.locale
  const text = lines.length
    ? [waCopy('requests_header', l), ...lines.map((r) => waCopy('requests_line', l, { title: redactContactInfo(String(r.title ?? '')).text.slice(0, 80), status: statusLabel('rfq', r.status, l) })), '', waCopy('requests_footer', l, { url: publicUrl(asBuyer ? '/app/rfq' : '/partner/rfqs', l) })].join('\n')
    : waCopy('requests_none', l)
  await replyWith(turn, 'wa_my_requests', 'requests', { text })
}

// ── a person ─────────────────────────────────────────────────────────────────

const TICKET_SUMMARY: Record<'human' | 'abuse', string> = {
  human: 'Opened from the WhatsApp menu: the person asked to talk to a person. See the transcript.',
  abuse: 'REPORT on WhatsApp: the person reported a suspicious message. See the transcript.',
}

/**
 * A support ticket for the bound user, as the Support agent's escalation writes it when the web route is unavailable
 * (one OPEN ticket per user and channel — a second request joins it). The conversation points at it, so the agent stays
 * quiet there until a person resolves it at /admin/support. Null when the ticket table is not there (0041).
 */
export async function openTicket(db: SupabaseClient, args: { userId: string; conversationId: string; reason: 'human' | 'abuse' }): Promise<{ id: string; ref: string; created: boolean } | null> {
  const existing = async () => {
    const { data, error } = await db.from('support_tickets').select('id').eq('user_id', args.userId).eq('channel', 'whatsapp').neq('status', 'resolved').is('deleted_at', null).limit(1).maybeSingle()
    if (error && isMissingSchemaError(error)) throw error
    return (data as { id: string } | null) ?? null
  }
  try {
    let row = await existing()
    let created = false
    if (!row) {
      const { msmeId } = await profilesOf(db, args.userId)
      const { data: u } = await db.from('users').select('roles').eq('id', args.userId).maybeSingle()
      const roles = ((u as { roles?: string[] | null } | null)?.roles ?? []) as string[]
      const role = msmeId || !roles.includes('provider') ? 'buyer' : 'provider'
      const { data, error } = await db
        .from('support_tickets')
        .insert({ user_id: args.userId, role, channel: 'whatsapp', conversation_id: args.conversationId, intent: args.reason === 'abuse' ? 'report' : 'human', reason: args.reason, summary: TICKET_SUMMARY[args.reason] })
        .select('id')
        .single()
      if (error && isMissingSchemaError(error)) throw error
      row = (data as { id: string } | null) ?? (error ? await existing() : null)
      created = !!data
    }
    if (!row) return null
    await db.from('wa_conversations').update({ support_ticket_id: row.id }).eq('id', args.conversationId)
    return { id: row.id, ref: ticketRefFromId(row.id), created }
  } catch (e) {
    logMissingOnce('support_tickets', (e as Error).message ?? String(e))
    return null
  }
}

export async function talkToPerson(turn: WaTurn, reason: 'human'): Promise<void> {
  const contact = { email: WA_HELP_CONTACT.email, phone: WA_HELP_CONTACT.phone, hours: WA_HELP_CONTACT.acknowledgeHours }
  if (!turn.conv.user_id) {
    await replyWith(turn, 'wa_human', 'human', { text: waCopy('human_contact', turn.locale, contact) })
    return
  }
  const t = await openTicket(turn.db, { userId: turn.conv.user_id, conversationId: turn.conv.id, reason })
  if (!t) {
    await replyWith(turn, 'wa_human', 'human', { text: waCopy('human_contact', turn.locale, contact) })
    return
  }
  if (t.created) turn.capture(turn.conv.user_id, 'support_ticket_opened', { channel: 'whatsapp', reason, has_summary: false, via: 'wa_menu' })
  await replyWith(turn, 'wa_human', 'human', { text: waCopy('human_opened', turn.locale, { ref: t.ref, hours: WA_HELP_CONTACT.acknowledgeHours }) })
}

/** REPORT: a ticket (reason abuse) for an account; for an unknown number the message is flagged for ops. */
export async function reportMessage(turn: WaTurn): Promise<void> {
  if (turn.conv.user_id) {
    const t = await openTicket(turn.db, { userId: turn.conv.user_id, conversationId: turn.conv.id, reason: 'abuse' })
    if (t) {
      if (t.created) turn.capture(turn.conv.user_id, 'support_ticket_opened', { channel: 'whatsapp', reason: 'abuse', has_summary: false, via: 'wa_report' })
      await replyWith(turn, 'wa_report_received', 'report', { text: waCopy('report_received', turn.locale, { ref: t.ref }) })
      return
    }
  }
  const { data } = await turn.db.from('wa_messages').select('payload').eq('id', turn.messageId).maybeSingle()
  const payload = ((data as { payload?: Record<string, unknown> | null } | null)?.payload ?? {}) as Record<string, unknown>
  await turn.db.from('wa_messages').update({ payload: { ...payload, amc_flag: 'report' } }).eq('id', turn.messageId)
  turn.capture(distinctIdOf(turn), 'wa_report', { known: !!turn.conv.user_id })
  await replyWith(turn, 'wa_report_received', 'report', { text: waCopy('report_received_unknown', turn.locale) })
}

// ── language ─────────────────────────────────────────────────────────────────

export async function sendLanguageList(turn: WaTurn): Promise<void> {
  await replyWith(turn, 'wa_language_list', 'language_list', { text: waCopy('language_pick', turn.locale), buttons: waLanguageRows() })
}

/**
 * One language across web, mobile and WhatsApp (audit 5 #10): the conversation's locale and, for an account, the
 * user's own `preferred_locale`. The confirmation goes out in the NEW language.
 */
export async function setLanguage(turn: WaTurn, target: WaLocale, via: 'keyword' | 'button'): Promise<void> {
  const from = turn.locale
  await turn.db.from('wa_conversations').update({ locale: target }).eq('id', turn.conv.id)
  if (turn.conv.user_id) await turn.db.from('users').update({ preferred_locale: target }).eq('id', turn.conv.user_id)
  turn.locale = target
  turn.capture(distinctIdOf(turn), 'wa_language_changed', { from, to: target, via, known: !!turn.conv.user_id })
  const language = WA_LANGUAGE_NAMES[target]
  await replyWith(turn, 'wa_language_changed', 'language', { text: waCopy('language_changed', target, { language }), values: { language } })
}

// ── data requests (DPDP, ADR-030 §6) ─────────────────────────────────────────

function istDate(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}

export function dpdpRefFromId(id: string): string {
  return `D-${id.slice(0, 8).toUpperCase()}`
}

/**
 * MY DATA / DELETE MY DATA → a dpdp_requests row (source whatsapp) for the bound user, or the phone alone for a number
 * that is not an account, due `dueDays` from now; ops work it from the admin console. Without 0087 the person is
 * pointed to the grievance email instead (nothing is claimed that was not recorded).
 */
export async function dataRequest(turn: WaTurn, kind: 'access' | 'erasure', dueDays: number): Promise<void> {
  const due = new Date(turn.now.getTime() + dueDays * 24 * 3600 * 1000)
  const digits = /^\d{8,15}$/.test(turn.conv.phone_e164) ? turn.conv.phone_e164 : null
  let { data, error } = await turn.db
    .from('dpdp_requests')
    .insert({ user_id: turn.conv.user_id, phone_e164: digits, kind, source: 'whatsapp', details: `WhatsApp keyword (${kind === 'access' ? 'MY DATA' : 'DELETE MY DATA'})`, due_at: due.toISOString() })
    .select('id')
    .single()
  // dpdp_requests_one_open_per_kind: the person already has this request open (web or an earlier keyword) — confirm
  // that one rather than failing
  if (error && (error as { code?: string }).code === '23505' && turn.conv.user_id) {
    const again = await turn.db.from('dpdp_requests').select('id').eq('user_id', turn.conv.user_id).eq('kind', kind).in('status', ['open', 'in_progress']).is('deleted_at', null).limit(1).maybeSingle()
    data = again.data as typeof data
    error = again.error
  }
  if (error || !data) {
    if (error && isMissingSchemaError(error)) logMissingOnce('dpdp_requests', error.message)
    else if (error) console.error('[wa] dpdp_requests insert failed', error.message)
    await replyWith(turn, 'wa_data_request_unavailable', 'data', { text: waCopy('data_unavailable', turn.locale, { email: WA_HELP_CONTACT.grievanceEmail }) })
    return
  }
  const ref = dpdpRefFromId((data as { id: string }).id)
  const what = waCopy(kind === 'access' ? 'data_what_access' : 'data_what_erasure', turn.locale)
  const date = istDate(due)
  turn.capture(distinctIdOf(turn), 'wa_dpdp_request', { kind, known: !!turn.conv.user_id })
  await replyWith(turn, 'wa_data_request_received', 'data', { text: waCopy('data_received', turn.locale, { what, ref, date }), values: { what, ref, date } })
}

// ── fixed replies ────────────────────────────────────────────────────────────

export async function fixedReply(turn: WaTurn, kind: string, key: WaCopyKey, slots: Record<string, string> = {}, buttons?: Array<{ id: string; title: string }>): Promise<void> {
  await replyWith(turn, kind, key, { text: waCopy(key, turn.locale, slots), ...(buttons ? { buttons } : {}) })
}

/** JOIN before any opt-in: consent is START or a button (audit B4), so JOIN asks for the tap first. */
export async function joinNeedsStart(turn: WaTurn): Promise<void> {
  await fixedReply(turn, 'wa_join_needs_start', 'join_needs_start', {}, [{ id: WA_PAYLOAD_START, title: waCopy('button_start', turn.locale) }])
}

/** A business-scoped id with no phone (Meta usernames): nothing can be linked; say how to share the number. */
export async function sharePhoneReply(turn: WaTurn): Promise<void> {
  await fixedReply(turn, 'wa_share_phone', 'share_phone', { email: WA_HELP_CONTACT.email })
  await markAutoReply(turn)
}

/** A dormant account or a number that changed hands: sign in first ("confirm it's you"). */
export async function rebindPrompt(turn: WaTurn): Promise<void> {
  await fixedReply(turn, 'wa_rebind_confirm', 'rebind_confirm', { url: publicUrl('/login', turn.locale) })
  await markAutoReply(turn)
  turn.capture(distinctIdOf(turn), 'wa_rebind_prompted', {})
}
