import 'server-only'
import { reduceWaPayload, waStoredMediaPath } from '@amclub/shared'
import { notReady, removeStorageObjects, WA_MEDIA_BUCKET, type Admin } from './common'

/**
 * ADR-030 §6 — the WhatsApp half of a DPDP erasure request, run from /admin/privacy when ops mark the request done:
 *
 *  - every wa_messages row of the conversations bound to the user (and every row carrying the user, 0086) loses its
 *    body, transcript, media and payload (ids / kind / status / times stay), and its wa-media object is deleted;
 *  - the conversations are unbound (user, bind time and the routes to their sessions and ticket cleared);
 *  - the user's WhatsApp agent grants are revoked.
 *
 * Kept on purpose: `wa_consent_events` (append-only legal proof of what the phone agreed to and when); rows on an
 * explicit legal hold (counted and reported); the users row and business records the law requires us to keep (orders,
 * invoices, payments) — the resolution the user reads says so. If the phone is still the account's phone, a later
 * message binds a fresh conversation again: that is new data, not the erased history.
 */

export interface WaErasureResult {
  notReady: boolean
  conversations: number
  messagesRedacted: number
  keptOnHold: number
  mediaDeleted: number
  grantsRevoked: number
  errors: number
}

const BATCH = 500
const MAX_ROWS = 20_000

interface Row { id: string; media_ref: string | null; payload: unknown }

async function redactRows(admin: Admin, filter: { conversationIds?: string[]; userId?: string }, out: WaErasureResult): Promise<void> {
  let done = 0
  let after: string | null = null
  while (done < MAX_ROWS) {
    let q = admin.from('wa_messages').select('id, media_ref, payload').is('redacted_at', null).eq('legal_hold', false).order('id', { ascending: true }).limit(BATCH)
    if (filter.conversationIds) q = q.in('conversation_id', filter.conversationIds)
    if (filter.userId) q = q.eq('user_id', filter.userId)
    if (after) q = q.gt('id', after)
    const { data, error } = await q
    if (error) {
      if (notReady('wa_messages erasure columns (0086)', error)) { out.notReady = true; return }
      out.errors++
      console.error('[wa-erasure] scan', error.message)
      return
    }
    const rows = (data ?? []) as Row[]
    if (rows.length === 0) return
    after = rows[rows.length - 1]!.id
    done += rows.length
    const paths = rows.map((r) => waStoredMediaPath(r.media_ref)).filter((p): p is string => !!p)
    const removed = paths.length ? await removeStorageObjects(admin, WA_MEDIA_BUCKET, paths) : { removed: 0, failed: false }
    if (removed.failed) out.errors++
    out.mediaDeleted += removed.removed
    const now = new Date().toISOString()
    for (const r of rows) {
      const { error: upErr } = await admin
        .from('wa_messages')
        .update({ body: null, transcript: null, media_ref: null, payload: reduceWaPayload(r.payload), redacted_at: now })
        .eq('id', r.id)
        .is('redacted_at', null)
        .eq('legal_hold', false)
      if (upErr) { out.errors++; continue }
      out.messagesRedacted++
    }
    if (rows.length < BATCH) return
  }
}

export async function eraseWhatsAppData(admin: Admin, userId: string): Promise<WaErasureResult> {
  const out: WaErasureResult = { notReady: false, conversations: 0, messagesRedacted: 0, keptOnHold: 0, mediaDeleted: 0, grantsRevoked: 0, errors: 0 }
  const { data: convs, error: convErr } = await admin.from('wa_conversations').select('id').eq('user_id', userId)
  if (convErr) { out.errors++; console.error('[wa-erasure] conversations', convErr.message); return out }
  const convIds = ((convs ?? []) as { id: string }[]).map((c) => c.id)
  out.conversations = convIds.length

  for (let i = 0; i < convIds.length; i += 50) {
    await redactRows(admin, { conversationIds: convIds.slice(i, i + 50) }, out)
    if (out.notReady) return out
  }
  await redactRows(admin, { userId }, out)
  if (out.notReady) return out

  // rows kept because of an explicit legal hold (reported to ops and in the resolution)
  const held = convIds.length
    ? await admin.from('wa_messages').select('id', { count: 'exact', head: true }).in('conversation_id', convIds.slice(0, 200)).eq('legal_hold', true).is('redacted_at', null)
    : { count: 0, error: null }
  out.keptOnHold = held.count ?? 0

  if (convIds.length) {
    const unbind = { user_id: null, active_session_id: null, support_ticket_id: null, procurement_session_id: null, updated_at: new Date().toISOString() }
    let { error } = await admin.from('wa_conversations').update({ ...unbind, bound_at: null }).eq('user_id', userId)
    if (error && notReady('wa_conversations.bound_at (0086)', error)) ({ error } = await admin.from('wa_conversations').update(unbind).eq('user_id', userId))
    if (error) { out.errors++; console.error('[wa-erasure] unbind', error.message) }
  }

  const { data: revoked, error: grantErr } = await admin
    .from('agent_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('channel', 'whatsapp')
    .is('revoked_at', null)
    .select('id')
  if (grantErr) { out.errors++; console.error('[wa-erasure] grants', grantErr.message) }
  out.grantsRevoked = (revoked ?? []).length
  return out
}
