import type { SupabaseClient } from '@supabase/supabase-js'
import type { Ledger } from '@amclub/agent-core'
import { PROCUREMENT_SESSION_STATES, procurementSessionIsActive, waLocaleFor } from '@amclub/shared'

const ACTIVE_PROCUREMENT_STATES = PROCUREMENT_SESSION_STATES.filter((s) => procurementSessionIsActive(s))

/**
 * WhatsApp identity binding (audit M41). A conversation is ONE phone; it acts
 * for a user only while that user's CURRENT `users.phone` is that phone, and a
 * WhatsApp grant counts only for the phone it was given from
 * (`agent_grants.channel_identity = '+' || phone_e164`). Consent and delivery
 * are tied to the phone, never to "the user's most recent conversation":
 *
 *  - every inbound message re-derives the owner (`reconcileConversationOwner`):
 *    a conversation whose user no longer holds the phone is unbound, that
 *    phone's grants are revoked, and the Munshi drafts / procurement proposals
 *    delivered there are cancelled — then the current holder (if any) is bound;
 *  - every WhatsApp grant lookup filters on the channel identity;
 *  - every outbound picks the conversation of the user's current phone
 *    (`boundConversationFor`).
 *
 * ADR-030 adds two callers of the same halt: STOP (`haltConversationWork`, the
 * conversation stays bound but nothing answers there any more) and Meta's "user
 * changed number" system message (`unbindConversation`).
 *
 * Migration 0079 adds the DB half: a trigger on `users.phone` that unbinds the
 * old phone's conversations and revokes its grants the moment the phone changes.
 * The service role here touches only wa_*, agent_grants, munshi_drafts,
 * procurement_sessions and the run ledger (agent-writes audit).
 */

/** E.164 digits, no '+', no separators (users.phone is stored '+91…'; the vendors send bare digits). */
export function phoneDigits(phone: string | null | undefined): string {
  return String(phone ?? '').replace(/\D/g, '')
}

/** The grant identity for a conversation phone. */
export function channelIdentityOf(phoneE164: string): string {
  return `+${phoneDigits(phoneE164)}`
}

export interface PhoneUser {
  id: string
  phone: string | null
  preferred_locale: string | null
  roles: string[]
}

/** The user holding this phone now (users.phone is UNIQUE). Matches the '+' form and bare digits. */
export async function userByPhone(admin: SupabaseClient, digits: string): Promise<PhoneUser | null> {
  // ADR-030 / audit 2.9: a BSUID-only conversation is keyed `u:<bsuid>` — never a phone, never reduced to digits
  if (String(digits ?? '').startsWith('u:')) return null
  const d = phoneDigits(digits)
  if (!d) return null
  const { data } = await admin.from('users').select('id, phone, preferred_locale, roles').in('phone', [`+${d}`, d]).limit(1).maybeSingle()
  if (!data) return null
  const u = data as { id: string; phone: string | null; preferred_locale?: string | null; roles?: string[] | null }
  return { id: u.id, phone: u.phone, preferred_locale: u.preferred_locale ?? null, roles: u.roles ?? [] }
}

/** The user's current phone as digits ('' when none). */
export async function currentPhoneDigits(admin: SupabaseClient, userId: string): Promise<string> {
  const { data } = await admin.from('users').select('phone').eq('id', userId).maybeSingle()
  return phoneDigits((data as { phone?: string | null } | null)?.phone)
}

export interface WhatsAppGrantRow {
  id: string
  persona: string
  scopes: string[]
}

/** Active WhatsApp grants of `userId` given from THIS phone (optionally one persona). */
export async function whatsappGrantsFor(admin: SupabaseClient, userId: string, phoneE164: string, persona?: string): Promise<WhatsAppGrantRow[]> {
  const d = phoneDigits(phoneE164)
  if (!d) return []
  let q = admin.from('agent_grants').select('id, persona, scopes').eq('user_id', userId).eq('channel', 'whatsapp').eq('channel_identity', `+${d}`).is('revoked_at', null)
  if (persona) q = q.eq('persona', persona)
  const { data } = await q
  return ((data as { id: string; persona: string; scopes: string[] | null }[] | null) ?? []).map((g) => ({ id: g.id, persona: g.persona, scopes: g.scopes ?? [] }))
}

/** Active WhatsApp grants of `userId` for the user's CURRENT phone ([] with no phone). */
export async function currentWhatsAppGrants(admin: SupabaseClient, userId: string, persona?: string): Promise<WhatsAppGrantRow[]> {
  const d = await currentPhoneDigits(admin, userId)
  return d ? whatsappGrantsFor(admin, userId, d, persona) : []
}

export interface BoundConversation {
  id: string
  phone_e164: string
  window_open_until: string | null
}

/**
 * The conversation an outbound message to `userId` may use: the one whose phone
 * is the user's current phone AND is bound to the user. Never "the most recent
 * inbound" — an old number's conversation is never a delivery target.
 */
export async function boundConversationFor(admin: SupabaseClient, userId: string): Promise<BoundConversation | null> {
  const d = await currentPhoneDigits(admin, userId)
  if (!d) return null
  const { data } = await admin.from('wa_conversations').select('id, phone_e164, window_open_until').eq('phone_e164', d).eq('user_id', userId).maybeSingle()
  return (data as BoundConversation | null) ?? null
}

/** True when this conversation row may act for / deliver to `userId` (bound to them, and their current phone). */
export async function conversationServesUser(admin: SupabaseClient, conv: { user_id: string | null; phone_e164: string }, userId: string): Promise<boolean> {
  if (!conv.user_id || conv.user_id !== userId) return false
  return (await currentPhoneDigits(admin, userId)) === phoneDigits(conv.phone_e164)
}

export interface ReconcileResult {
  userId: string | null
  locale: string | null
  /** The user the conversation was bound to before, when it was unbound here. */
  unboundFrom: string | null
  revokedGrants: number
  cancelledDrafts: number
  closedSessions: number
}

async function cancelParkedRun(ledger: Ledger | null, runId: string | null, reason: string): Promise<void> {
  if (!ledger || !runId) return
  try {
    const run = await ledger.getRun(runId)
    if (run?.status === 'awaiting_confirmation') {
      await ledger.appendEvent({ runId, kind: 'declined', actor: 'system', payload: { reason } })
      await ledger.transitionRun(runId, 'awaiting_confirmation', 'cancelled')
    }
  } catch {
    /* already advanced */
  }
}

export interface HaltResult {
  cancelledDrafts: number
  closedSessions: number
}

/**
 * Stop every piece of agent work that answers on this conversation for `userId` (a phone change, a number change,
 * STOP — ADR-030 §2 "processing stops after STOP"): the conversation's pointers (onboarding session, procurement
 * session, support ticket) are cleared, the Munshi drafts whose buttons went out on WhatsApp are expired (their parked
 * runs cancelled), and the procurement sessions delivering to this conversation fail with their open proposal
 * cancelled. The onboarding session row and the support ticket stay (the web wizard / ops carry on); only their route
 * to this chat goes. Guarded writes: a concurrent job that already did it changes nothing.
 */
export async function haltConversationWork(
  admin: SupabaseClient,
  conv: { id: string },
  userId: string | null,
  opts: { ledger?: Ledger | null; now?: Date; reason: string },
): Promise<HaltResult> {
  const now = (opts.now ?? new Date()).toISOString()
  const out: HaltResult = { cancelledDrafts: 0, closedSessions: 0 }
  await admin.from('wa_conversations').update({ active_session_id: null, support_ticket_id: null, updated_at: now }).eq('id', conv.id)
  // the procurement pointer is a separate write: a database without 0045 then costs this line only
  await admin.from('wa_conversations').update({ procurement_session_id: null }).eq('id', conv.id)
  if (!userId) return out
  // Munshi drafts still open for the user whose buttons went out on WhatsApp: nothing is approved from a chat that
  // stopped (or is no longer theirs); the web / app keep nothing open for it either
  const { data: drafts } = await admin.from('munshi_drafts').select('id, run_id, delivered').eq('user_id', userId).eq('status', 'proposed').is('deleted_at', null).limit(100)
  for (const d of (drafts as { id: string; run_id: string | null; delivered: Record<string, unknown> | null }[] | null) ?? []) {
    if (!d.delivered || !d.delivered['whatsapp']) continue
    await cancelParkedRun(opts.ledger ?? null, d.run_id, opts.reason)
    const { data: upd } = await admin.from('munshi_drafts').update({ status: 'expired', result_ref: { reason: opts.reason }, updated_at: now }).eq('id', d.id).eq('status', 'proposed').select('id')
    if (Array.isArray(upd) && upd.length) out.cancelledDrafts++
  }
  // procurement sessions delivering to this conversation: their open proposal is cancelled and the session closes
  const { data: sessions } = await admin.from('procurement_sessions').select('id, state, open_run_id').eq('conversation_id', conv.id).eq('user_id', userId).is('deleted_at', null).in('state', ACTIVE_PROCUREMENT_STATES)
  for (const s of (sessions as { id: string; state: string; open_run_id: string | null }[] | null) ?? []) {
    await cancelParkedRun(opts.ledger ?? null, s.open_run_id, opts.reason)
    const { data: upd } = await admin.from('procurement_sessions').update({ state: 'failed', open_run_id: null, close_reason: opts.reason }).eq('id', s.id).eq('state', s.state).select('id')
    if (Array.isArray(upd) && upd.length) out.closedSessions++
  }
  return out
}

/**
 * Unbind a conversation from the user it is bound to: user_id → null (guarded on that user), the WhatsApp grants given
 * from this phone revoked, and its work halted (`haltConversationWork`). Used when the phone is no longer the user's
 * (audit M41) and on Meta's "user changed number" system message (ADR-030).
 */
export async function unbindConversation(
  admin: SupabaseClient,
  conv: { id: string; phone_e164: string; user_id: string | null },
  opts: { ledger?: Ledger | null; now?: Date; reason: string },
): Promise<{ unboundFrom: string | null; revokedGrants: number } & HaltResult> {
  const now = (opts.now ?? new Date()).toISOString()
  const old = conv.user_id
  if (!old) return { unboundFrom: null, revokedGrants: 0, ...(await haltConversationWork(admin, conv, null, opts)) }
  // 1. unbind — guarded on the user it was bound to (a concurrent job may already have done it)
  await admin.from('wa_conversations').update({ user_id: null, updated_at: now }).eq('id', conv.id).eq('user_id', old)
  // 2. the grants this phone gave (consent is the phone's, not the account's)
  const { data: revoked } = await admin.from('agent_grants').update({ revoked_at: now }).eq('user_id', old).eq('channel', 'whatsapp').eq('channel_identity', channelIdentityOf(conv.phone_e164)).is('revoked_at', null).select('id')
  // 3. the drafts / proposals / sessions answering here
  const halted = await haltConversationWork(admin, conv, old, opts)
  const revokedGrants = Array.isArray(revoked) ? revoked.length : 0
  console.warn('[wa] conversation unbound', JSON.stringify({ conversation: conv.id, reason: opts.reason, revoked: revokedGrants, drafts: halted.cancelledDrafts, sessions: halted.closedSessions }))
  return { unboundFrom: old, revokedGrants, ...halted }
}

let boundAtMissingLogged = false

/**
 * Re-derive the owner of a conversation from `users.phone` (called on EVERY
 * inbound message, before anything reads the binding). When the bound user no
 * longer holds the phone: unbind (`unbindConversation`: user_id and the
 * pointers → null, the WhatsApp grants given from this phone revoked, the
 * Munshi drafts delivered here cancelled, the procurement sessions that
 * deliver here closed). Then bind the phone's current holder.
 */
export async function reconcileConversationOwner(
  admin: SupabaseClient,
  conv: { id: string; phone_e164: string; user_id: string | null },
  opts: { ledger?: Ledger | null; now?: Date } = {},
): Promise<ReconcileResult> {
  const now = (opts.now ?? new Date()).toISOString()
  const out: ReconcileResult = { userId: conv.user_id, locale: null, unboundFrom: null, revokedGrants: 0, cancelledDrafts: 0, closedSessions: 0 }
  const holder = await userByPhone(admin, conv.phone_e164)
  if (conv.user_id && holder?.id === conv.user_id) {
    out.locale = holder.preferred_locale
    return out
  }
  if (conv.user_id) {
    const r = await unbindConversation(admin, conv, { ...opts, reason: 'phone_changed' })
    out.unboundFrom = r.unboundFrom
    out.revokedGrants = r.revokedGrants
    out.cancelledDrafts = r.cancelledDrafts
    out.closedSessions = r.closedSessions
    out.userId = null
  }
  // bind the phone's current holder (their own START from this phone creates their grants)
  if (holder) {
    const { data: bound } = await admin.from('wa_conversations').update({ user_id: holder.id, locale: waLocaleFor(holder.preferred_locale), updated_at: now }).eq('id', conv.id).is('user_id', null).select('id')
    if (Array.isArray(bound) && bound.length) {
      out.userId = holder.id
      out.locale = holder.preferred_locale
      // 0086: when the current holder was bound (transcripts never show an earlier holder's messages). A separate write,
      // so a database without 0086 costs this line only.
      const { error } = await admin.from('wa_conversations').update({ bound_at: now }).eq('id', conv.id)
      if (error && !boundAtMissingLogged) {
        boundAtMissingLogged = true
        console.error('[wa] wa_conversations.bound_at not written (apply migration 0086)', error.message)
      }
    }
  }
  return out
}
