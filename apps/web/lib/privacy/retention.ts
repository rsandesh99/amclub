import 'server-only'
import {
  agentSettingDefault,
  reduceWaPayload,
  waRetentionAction,
  waRetentionCutoffs,
  waStoredMediaPath,
  type WaRetentionCutoffs,
  type WaRetentionSettings,
} from '@amclub/shared'
import { getAgentSetting } from '@/lib/agent/settings'
import type { TimeBudget } from '@/lib/jobs/budget'
import { notReady, removeStorageObjects, SchemaNotReadyError, WA_MEDIA_BUCKET, type Admin } from './common'
import { heldUserIds } from './holds'

/**
 * ADR-030 §6 / D-WA5 — the daily WhatsApp retention job (cron wa-retention).
 *
 *  1. text: messages older than `wa_retention_text_days` lose body, transcript, media and every payload field but ids,
 *     kind, status and times; `redacted_at` is set. Their stored media objects are deleted first.
 *  2. media: messages older than `wa_retention_media_days` lose their wa-media object (the text stays until step 1).
 *  3. unknown numbers: the conversation (and its messages and media) of a number that never bound to an account and was
 *     quiet for `wa_retention_unknown_days` is deleted. Consent events are keyed by phone and stay as proof.
 *
 * Nothing is touched while `legal_hold` is true or the message's user has an open support ticket, an open dispute or an
 * order not yet done (lib/privacy/holds.ts). Bounded: batches of 200, at most MAX_SCAN rows per step per run, inside
 * the route's time budget; whatever is left is picked up tomorrow (every write re-checks the state it expects).
 */

const BATCH = 200
const MAX_SCAN = 5000
const CONV_BATCH = 100

export interface WaRetentionResult {
  /** 0086 is not applied yet: nothing ran (degraded heartbeat). */
  notReady: boolean
  settings: WaRetentionSettings | null
  scanned: number
  redacted: number
  mediaRemoved: number
  mediaObjectsDeleted: number
  conversationsDeleted: number
  held: number
  errors: number
  /** The time budget ran out before every step finished (the rest runs tomorrow). */
  partial: boolean
}

export async function readRetentionSettings(admin: Admin): Promise<WaRetentionSettings> {
  const n = async (key: 'wa_retention_text_days' | 'wa_retention_media_days' | 'wa_retention_unknown_days') => {
    try {
      const v = Number(await getAgentSetting(admin, key))
      return Number.isInteger(v) && v > 0 ? v : Number(agentSettingDefault(key))
    } catch {
      return Number(agentSettingDefault(key))
    }
  }
  return { textDays: await n('wa_retention_text_days'), mediaDays: await n('wa_retention_media_days'), unknownDays: await n('wa_retention_unknown_days') }
}

interface MsgRow {
  id: string
  conversation_id: string
  user_id: string | null
  media_ref: string | null
  payload: unknown
  created_at: string
  legal_hold: boolean
  redacted_at: string | null
}

/** The user each message belongs to: the row's own user (0086), else its conversation's current user. */
async function ownersOf(admin: Admin, rows: readonly MsgRow[]): Promise<Map<string, string | null>> {
  const convIds = [...new Set(rows.map((r) => r.conversation_id))]
  const { data, error } = convIds.length ? await admin.from('wa_conversations').select('id, user_id').in('id', convIds) : { data: [], error: null }
  if (error) throw new Error(`wa_conversations: ${error.message}`)
  const convUser = new Map(((data ?? []) as { id: string; user_id: string | null }[]).map((c) => [c.id, c.user_id]))
  return new Map(rows.map((r) => [r.id, r.user_id ?? convUser.get(r.conversation_id) ?? null]))
}

async function step(
  admin: Admin,
  mode: 'text' | 'media',
  cutoffs: WaRetentionCutoffs,
  budget: TimeBudget,
  out: WaRetentionResult,
): Promise<void> {
  const cutoff = mode === 'text' ? cutoffs.text : cutoffs.media
  let after: string | null = null
  let scanned = 0
  while (scanned < MAX_SCAN) {
    if (budget.spent()) { out.partial = true; return }
    let q = admin
      .from('wa_messages')
      .select('id, conversation_id, user_id, media_ref, payload, created_at, legal_hold, redacted_at')
      .lt('created_at', cutoff)
      .is('redacted_at', null)
      .eq('legal_hold', false)
      .order('created_at', { ascending: true })
      .limit(BATCH)
    if (mode === 'media') q = q.not('media_ref', 'is', null)
    if (after) q = q.gt('created_at', after)
    const { data, error } = await q
    if (error) {
      if (notReady('wa_messages retention columns (0086)', error)) throw new SchemaNotReadyError('wa_messages')
      out.errors++
      console.error(`[wa-retention] ${mode} scan`, error.message)
      return
    }
    const rows = (data ?? []) as MsgRow[]
    if (rows.length === 0) return
    scanned += rows.length
    out.scanned += rows.length
    after = rows[rows.length - 1]!.created_at

    const owners = await ownersOf(admin, rows)
    const { held } = await heldUserIds(admin, [...owners.values()].filter((u): u is string => !!u))
    const act: MsgRow[] = []
    for (const r of rows) {
      const owner = owners.get(r.id) ?? null
      const action = waRetentionAction({ createdAt: r.created_at, legalHold: r.legal_hold, redactedAt: r.redacted_at, mediaRef: r.media_ref, userHeld: !!owner && held.has(owner) }, cutoffs)
      if ((mode === 'text' && action === 'redact') || (mode === 'media' && action === 'remove_media')) act.push(r)
      else if (owner && held.has(owner)) out.held++
    }
    if (act.length === 0) { if (rows.length < BATCH) return; continue }

    // media objects first: a row keeps its reference until its object is gone, so a failed delete is retried tomorrow
    const paths = act.map((r) => waStoredMediaPath(r.media_ref)).filter((p): p is string => !!p)
    const removed = paths.length ? await removeStorageObjects(admin, WA_MEDIA_BUCKET, paths) : { removed: 0, failed: false }
    if (removed.failed) { out.errors++; if (rows.length < BATCH) return; continue }
    out.mediaObjectsDeleted += removed.removed

    const now = new Date().toISOString()
    for (const r of act) {
      if (budget.spent()) { out.partial = true; return }
      const patch = mode === 'text'
        ? { body: null, transcript: null, media_ref: null, payload: reduceWaPayload(r.payload), redacted_at: now }
        : { media_ref: null }
      const { error: upErr } = await admin.from('wa_messages').update(patch).eq('id', r.id).is('redacted_at', null).eq('legal_hold', false)
      if (upErr) { out.errors++; console.error(`[wa-retention] ${mode} update`, r.id, upErr.message); continue }
      if (mode === 'text') out.redacted++
      else out.mediaRemoved++
    }
    if (rows.length < BATCH) return
  }
}

/** Step 3: numbers that never bound to an account. */
async function unknownNumbers(admin: Admin, cutoffs: WaRetentionCutoffs, budget: TimeBudget, out: WaRetentionResult): Promise<void> {
  let after: string | null = null
  let scanned = 0
  const cut = new Date(cutoffs.unknown).getTime()
  while (scanned < MAX_SCAN) {
    if (budget.spent()) { out.partial = true; return }
    let q = admin
      .from('wa_conversations')
      .select('id, phone_e164, created_at, last_inbound_at, last_outbound_at')
      .is('user_id', null)
      .is('bound_at', null)
      .lt('created_at', cutoffs.unknown)
      .order('created_at', { ascending: true })
      .limit(CONV_BATCH)
    if (after) q = q.gt('created_at', after)
    const { data, error } = await q
    if (error) {
      if (notReady('wa_conversations.bound_at (0086)', error)) throw new SchemaNotReadyError('wa_conversations')
      out.errors++
      console.error('[wa-retention] unknown scan', error.message)
      return
    }
    const convs = (data ?? []) as { id: string; phone_e164: string; created_at: string; last_inbound_at: string | null; last_outbound_at: string | null }[]
    if (convs.length === 0) return
    scanned += convs.length
    after = convs[convs.length - 1]!.created_at
    const quiet = convs.filter((c) => [c.last_inbound_at, c.last_outbound_at].every((t) => !t || new Date(t).getTime() < cut))
    const ids = quiet.map((c) => c.id)
    if (ids.length) {
      // Any sign an account was ever behind the number keeps it (a conversation bound before 0086 has no bound_at): a
      // ticket, a message carrying a user, a legal hold, a consent event or a WhatsApp grant given from that phone.
      const phones = quiet.map((c) => c.phone_e164)
      const [tickets, owned, holds, consents, grants] = await Promise.all([
        admin.from('support_tickets').select('conversation_id').in('conversation_id', ids),
        admin.from('wa_messages').select('conversation_id').in('conversation_id', ids).not('user_id', 'is', null).limit(1000),
        admin.from('wa_messages').select('conversation_id').in('conversation_id', ids).eq('legal_hold', true).limit(1000),
        admin.from('wa_consent_events').select('phone_e164').in('phone_e164', phones).not('user_id', 'is', null).limit(1000),
        admin.from('agent_grants').select('channel_identity').eq('channel', 'whatsapp').in('channel_identity', phones.map((p) => `+${p}`)).limit(1000),
      ])
      const failed = [owned, holds, consents, grants].find((r) => r.error) ?? (tickets.error && !/support_tickets/.test(tickets.error.message) ? tickets : null)
      if (failed) { out.errors++; console.error('[wa-retention] unknown evidence', failed.error?.message); return }
      const knownPhones = new Set<string>([
        ...((consents.data ?? []) as { phone_e164: string }[]).map((c) => c.phone_e164),
        ...((grants.data ?? []) as { channel_identity: string | null }[]).map((g) => String(g.channel_identity ?? '').replace(/\D/g, '')),
      ])
      const keep = new Set<string>([
        ...((tickets.data ?? []) as { conversation_id: string }[]).map((t) => t.conversation_id),
        ...((owned.data ?? []) as { conversation_id: string }[]).map((t) => t.conversation_id),
        ...((holds.data ?? []) as { conversation_id: string }[]).map((t) => t.conversation_id),
        ...quiet.filter((c) => knownPhones.has(c.phone_e164)).map((c) => c.id),
      ])
      for (const id of ids) {
        if (keep.has(id)) continue
        if (budget.spent()) { out.partial = true; return }
        const { data: objs, error: listErr } = await admin.storage.from(WA_MEDIA_BUCKET).list(id, { limit: 1000 })
        if (listErr && !/not found/i.test(listErr.message)) { out.errors++; continue }
        const paths = ((objs ?? []) as { name: string }[]).filter((o) => o.name).map((o) => `${id}/${o.name}`)
        const removed = paths.length ? await removeStorageObjects(admin, WA_MEDIA_BUCKET, paths) : { removed: 0, failed: false }
        if (removed.failed) { out.errors++; continue }
        out.mediaObjectsDeleted += removed.removed
        // messages go with the conversation (ON DELETE CASCADE); guarded on still being unbound
        const { data: del, error: delErr } = await admin.from('wa_conversations').delete().eq('id', id).is('user_id', null).is('bound_at', null).select('id')
        if (delErr) { out.errors++; console.error('[wa-retention] unknown delete', id, delErr.message); continue }
        out.conversationsDeleted += (del ?? []).length
      }
    }
    if (convs.length < CONV_BATCH) return
  }
}

export async function runWaRetention(admin: Admin, budget: TimeBudget, now: Date = new Date()): Promise<WaRetentionResult> {
  const out: WaRetentionResult = { notReady: false, settings: null, scanned: 0, redacted: 0, mediaRemoved: 0, mediaObjectsDeleted: 0, conversationsDeleted: 0, held: 0, errors: 0, partial: false }
  // readiness probe: the retention columns come with 0086
  const probe = await admin.from('wa_messages').select('id, redacted_at, legal_hold').limit(1)
  if (probe.error) {
    if (notReady('wa_messages retention columns (0086)', probe.error)) return { ...out, notReady: true }
    throw new Error(`wa_messages: ${probe.error.message}`)
  }
  const settings = await readRetentionSettings(admin)
  out.settings = settings
  const cutoffs = waRetentionCutoffs(now, settings)
  try {
    await step(admin, 'text', cutoffs, budget, out)
    await step(admin, 'media', cutoffs, budget, out)
    await unknownNumbers(admin, cutoffs, budget, out)
  } catch (e) {
    if (e instanceof SchemaNotReadyError) return { ...out, notReady: true }
    throw e
  }
  return out
}
