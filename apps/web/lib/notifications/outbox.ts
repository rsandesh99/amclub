import 'server-only'
import {
  OUTBOX_CLAIM_MS,
  deferUntil,
  kindSpec,
  outboxKey,
  outboxRetryAt,
  planChannels,
  type ExternalChannel,
  type NotificationPreference,
  type NotifySettingsRow,
} from '@amclub/shared'
import { getAgentSetting } from '@/lib/agent/settings'
import { UNBOUNDED, type TimeBudget } from '@/lib/jobs/budget'
import { notifyText } from '@/lib/i18n/notify'
import { CHANNEL_HANDLERS, absoluteLink, type ChannelMessage, type ChannelResult } from './channels'
import type { DltTemplates } from './sms'
import { isMissingRelation, loadPrefs, loadRecipients, markOutboxMissing, markOutboxPresent, type Admin, type Recipient, type TextLocale } from './store'

/**
 * ADR-030 §4 — the notification outbox (migration 0087). Every external send is one row per (notification, channel)
 * under the unique key `${notificationId}:${channel}`; the per-minute cron `notify-dispatch` claims due rows one at a
 * time (compare-and-set on status + attempts, a two-minute lease), re-checks quiet hours / pause / preferences, sends
 * through the channel handler and records the outcome:
 *   sent      — delivered to the vendor (or a stub outside production);
 *   skipped   — nothing to send (no address, no DLT template, the preference is now off);
 *   queued    — a retryable failure waits 1, 5, 15, 60 minutes (five attempts in all);
 *   failed    — final;
 *   fallback  — a WhatsApp that was not allowed or did not deliver handed over to SMS (when the kind has a DLT
 *               template) and / or email (when the user has an address): new rows with fallback_of set, keyed on the
 *               notification, so a channel already sent is never doubled;
 *   deferred  — waiting for the end of quiet hours, a pause, or the 09:00 IST lead digest (the cron collapses a
 *               provider's due digest rows into one "N new requests" message).
 */

export interface OutboxPayload {
  v: 1
  locale: TextLocale
  title: string
  body: string
  /** App-relative. */
  link: string | null
  values: Record<string, string>
  /** WhatsApp rows: channels to try when WhatsApp does not deliver. */
  fallback?: ExternalChannel[]
  /** A lead on the provider's 09:00 digest. */
  digest?: boolean
  /** The caller chose the channels (a documented system caller): no preference re-check at send time. */
  override?: boolean
}

export interface OutboxDraft {
  notificationId: string | null
  /** The id the key is built on (the notification id, or a stand-in when the in-app insert failed). */
  keyId: string
  userId: string
  kind: string
  channel: ExternalChannel
  payload: OutboxPayload
  status: 'queued' | 'deferred'
  nextAttemptAt: string
}

interface OutboxRow {
  id: string
  notification_id: string | null
  user_id: string
  kind: string
  channel: ExternalChannel
  payload: OutboxPayload
  status: 'queued' | 'sending' | 'deferred' | 'sent' | 'failed' | 'skipped' | 'fallback'
  attempts: number
  next_attempt_at: string
  claimed_until: string | null
  fallback_of: string | null
  idempotency_key: string
}

/** Insert the rows; a key already present is left as it is (idempotent). */
export async function enqueueOutbox(admin: Admin, drafts: OutboxDraft[]): Promise<'ok' | 'missing' | 'error'> {
  if (drafts.length === 0) return 'ok'
  const rows = drafts.map((d) => ({
    notification_id: d.notificationId,
    user_id: d.userId,
    kind: d.kind,
    channel: d.channel,
    payload: d.payload,
    status: d.status,
    next_attempt_at: d.nextAttemptAt,
    idempotency_key: outboxKey(d.keyId, d.channel),
  }))
  const { error } = await admin.from('notification_outbox').upsert(rows, { onConflict: 'idempotency_key', ignoreDuplicates: true })
  if (!error) {
    markOutboxPresent()
    return 'ok'
  }
  if (isMissingRelation(error)) {
    markOutboxMissing('outbox insert')
    return 'missing'
  }
  console.error('[notify:outbox] enqueue failed', { kind: drafts[0]!.kind, rows: rows.length, code: error.code, message: error.message })
  return 'error'
}

export async function loadDltTemplates(admin: Admin): Promise<DltTemplates> {
  try {
    const v = await getAgentSetting(admin, 'sms_dlt_templates')
    return v && typeof v === 'object' ? (v as DltTemplates) : {}
  } catch (e) {
    console.error('[notify] sms_dlt_templates', (e as Error).message)
    return {}
  }
}

const pick = (m: { en: string; hi: string; te?: string; ta?: string }, l: TextLocale) => m[l] ?? m.en

/** The keyId of a row (its key is `${keyId}:${channel}`). */
const keyIdOf = (row: Pick<OutboxRow, 'idempotency_key'>) => row.idempotency_key.slice(0, row.idempotency_key.lastIndexOf(':'))

export function messageFor(row: Pick<OutboxRow, 'notification_id' | 'user_id' | 'kind' | 'idempotency_key'>, payload: OutboxPayload, user: Recipient | undefined, over?: Partial<ChannelMessage>): ChannelMessage {
  return {
    notificationId: row.notification_id,
    userId: row.user_id,
    kind: row.kind,
    email: user?.email ?? null,
    phone: user?.phone ?? null,
    locale: payload.locale ?? user?.locale ?? 'en',
    title: payload.title,
    body: payload.body,
    link: payload.link,
    absoluteLink: absoluteLink(payload.link),
    values: payload.values ?? {},
    idempotencyKey: row.idempotency_key,
    ...over,
  }
}

export interface DispatchRunResult {
  /** False when 0087 is not applied (nothing to process; the direct fan-out is in use). */
  ready: boolean
  claimed: number
  sent: number
  skipped: number
  deferred: number
  retried: number
  /** Final failures that no fallback took over. */
  failed: number
  fallbacks: number
  digests: number
  lost: number
}

interface BatchCtx {
  admin: Admin
  now: Date
  users: Map<string, Recipient>
  prefs: Map<string, NotificationPreference[]>
  settings: Map<string, NotifySettingsRow>
  dlt: DltTemplates
  result: DispatchRunResult
}

type Patch = Partial<Pick<OutboxRow, 'status' | 'next_attempt_at' | 'claimed_until' | 'attempts'>> & { detail?: string | null; last_error?: string | null }

async function finish(admin: Admin, ids: string[], patch: Patch): Promise<void> {
  if (ids.length === 0) return
  const { error } = await admin.from('notification_outbox').update({ claimed_until: null, ...patch }).in('id', ids).eq('status', 'sending')
  if (error) console.error('[notify:outbox] record outcome', error.message)
}

/** Hand a WhatsApp over to its fallback channels; the number of rows actually created. */
async function createFallbacks(ctx: BatchCtx, row: OutboxRow, payload: OutboxPayload, over?: { kind: string; keyId: string; payload: OutboxPayload }): Promise<number> {
  const user = ctx.users.get(row.user_id)
  const kind = over?.kind ?? row.kind
  const channels = (payload.fallback ?? []).filter((ch) => (ch === 'sms' ? !!user?.phone && !!ctx.dlt[kind] : ch === 'email' ? !!user?.email : false))
  if (channels.length === 0) return 0
  const nextPayload: OutboxPayload = { ...(over?.payload ?? payload) }
  delete nextPayload.fallback
  delete nextPayload.digest
  const keyId = over?.keyId ?? keyIdOf(row)
  const { data, error } = await ctx.admin
    .from('notification_outbox')
    .upsert(
      channels.map((ch) => ({
        notification_id: row.notification_id,
        user_id: row.user_id,
        kind,
        channel: ch,
        payload: nextPayload,
        status: 'queued',
        next_attempt_at: ctx.now.toISOString(),
        fallback_of: row.id,
        idempotency_key: outboxKey(keyId, ch),
      })),
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('id')
  if (error) {
    console.error('[notify:outbox] fallback insert', error.message)
    return 0
  }
  return (data ?? []).length
}

/** A WhatsApp that did not go: fallbacks when possible, else its own final status. */
async function settleUndelivered(ctx: BatchCtx, ids: string[], row: OutboxRow, payload: OutboxPayload, r: ChannelResult, finalStatus: 'skipped' | 'failed', over?: Parameters<typeof createFallbacks>[3]): Promise<void> {
  const created = r.channel === 'whatsapp' && r.fallback ? await createFallbacks(ctx, row, payload, over) : 0
  if (created > 0) {
    ctx.result.fallbacks += created
    await finish(ctx.admin, ids, { status: 'fallback', detail: r.detail.slice(0, 200), last_error: r.outcome === 'failed' ? r.detail.slice(0, 300) : null })
    return
  }
  if (finalStatus === 'failed') ctx.result.failed++
  else ctx.result.skipped++
  await finish(ctx.admin, ids, { status: finalStatus, detail: r.detail.slice(0, 200), last_error: r.outcome === 'failed' ? r.detail.slice(0, 300) : null })
}

/** Record what one send did for the row(s) it stood for. */
async function recordResult(ctx: BatchCtx, ids: string[], row: OutboxRow, attempts: number, payload: OutboxPayload, r: ChannelResult, over?: Parameters<typeof createFallbacks>[3]): Promise<void> {
  if (r.outcome === 'sent' || r.outcome === 'stub') {
    ctx.result.sent++
    await finish(ctx.admin, ids, { status: 'sent', detail: r.detail.slice(0, 200), last_error: null })
    return
  }
  if (r.outcome === 'skipped') return settleUndelivered(ctx, ids, row, payload, r, 'skipped', over)
  const retryAt = r.retryable ? outboxRetryAt(ctx.now, attempts) : null
  if (retryAt) {
    ctx.result.retried++
    await finish(ctx.admin, ids, { status: 'queued', next_attempt_at: retryAt.toISOString(), detail: r.detail.slice(0, 200), last_error: r.detail.slice(0, 300) })
    return
  }
  return settleUndelivered(ctx, ids, row, payload, r, 'failed', over)
}

/** Claim one due row: compare-and-set on the status and attempts it was read with. */
async function claim(admin: Admin, row: OutboxRow, now: Date): Promise<boolean> {
  const { data, error } = await admin
    .from('notification_outbox')
    .update({ status: 'sending', claimed_until: new Date(now.getTime() + OUTBOX_CLAIM_MS).toISOString(), attempts: row.attempts + 1 })
    .eq('id', row.id)
    .eq('status', row.status)
    .eq('attempts', row.attempts)
    .select('id')
  if (error) console.error('[notify:outbox] claim', error.message)
  return (data ?? []).length > 0
}

async function processDigest(ctx: BatchCtx, row: OutboxRow, attempts: number): Promise<void> {
  const nowIso = ctx.now.toISOString()
  // Collapse the user's other due lead rows on this channel into this one message.
  const { data: others } = await ctx.admin
    .from('notification_outbox')
    .select('id, status')
    .eq('user_id', row.user_id)
    .eq('channel', row.channel)
    .eq('kind', row.kind)
    .in('status', ['queued', 'deferred'])
    .lte('next_attempt_at', nowIso)
    .eq('payload->>digest', 'true')
    .neq('id', row.id)
    .limit(500)
  const otherIds = ((others ?? []) as { id: string }[]).map((o) => o.id)
  let absorbed: string[] = []
  if (otherIds.length) {
    const { data: got } = await ctx.admin
      .from('notification_outbox')
      .update({ status: 'sending', claimed_until: new Date(ctx.now.getTime() + OUTBOX_CLAIM_MS).toISOString() })
      .in('id', otherIds)
      .in('status', ['queued', 'deferred'])
      .select('id')
    absorbed = ((got ?? []) as { id: string }[]).map((g) => g.id)
  }
  const ids = [row.id, ...absorbed]
  const n = ids.length
  const payload = row.payload
  const user = ctx.users.get(row.user_id)
  const locale = payload.locale ?? user?.locale ?? 'en'
  const digestPayload: OutboxPayload = {
    v: 1,
    locale,
    title: pick(notifyText('rfq_digest.title', { n }), locale),
    body: pick(notifyText('rfq_digest.body', { n }), locale),
    link: '/partner/rfqs',
    values: { count: String(n) },
    ...(payload.fallback ? { fallback: payload.fallback } : {}),
  }
  const digestKeyId = `${row.id}:digest`
  const msg = messageFor({ ...row, kind: 'rfq_digest', idempotency_key: outboxKey(digestKeyId, row.channel) }, digestPayload, user)
  ctx.result.digests++
  const r = await CHANNEL_HANDLERS[row.channel](msg, { admin: ctx.admin, dltTemplates: ctx.dlt })
  await recordResult(ctx, ids, row, attempts, digestPayload, { ...r, detail: `digest:${n} ${r.detail}` }, { kind: 'rfq_digest', keyId: digestKeyId, payload: digestPayload })
}

async function processRow(ctx: BatchCtx, row: OutboxRow): Promise<void> {
  if (!(await claim(ctx.admin, row, ctx.now))) {
    ctx.result.lost++
    return
  }
  ctx.result.claimed++
  const attempts = row.attempts + 1
  const payload = row.payload
  const spec = kindSpec(row.kind)
  const settings = ctx.settings.get(row.user_id) ?? null
  try {
    // Quiet hours / pause are re-read at send time (the user may have changed them since the row was queued).
    const wait = deferUntil(ctx.now, settings, spec, row.channel)
    if (wait) {
      ctx.result.deferred++
      await finish(ctx.admin, [row.id], { status: 'deferred', next_attempt_at: wait.toISOString(), attempts: row.attempts })
      return
    }
    if (payload?.digest) return await processDigest(ctx, row, attempts)
    // A channel the user has switched off since (and no essential floor keeps) is not sent.
    if (!row.fallback_of && !payload?.override) {
      const user = ctx.users.get(row.user_id)
      const plan = planChannels(spec, ctx.prefs.get(row.user_id) ?? [], !!user?.email, !!user?.phone)
      if (!plan.now.includes(row.channel) && !plan.fallback.includes(row.channel)) {
        ctx.result.skipped++
        await finish(ctx.admin, [row.id], { status: 'skipped', detail: 'skipped:preference' })
        return
      }
    }
    const msg = messageFor(row, payload, ctx.users.get(row.user_id))
    const r = await CHANNEL_HANDLERS[row.channel](msg, { admin: ctx.admin, dltTemplates: ctx.dlt })
    await recordResult(ctx, [row.id], row, attempts, payload, r)
  } catch (e) {
    // Ours, not the vendor's: back to the queue with the ordinary backoff.
    const retryAt = outboxRetryAt(ctx.now, attempts)
    const detail = `error:${(e as Error).message}`.slice(0, 300)
    console.error('[notify:outbox] row', row.id, detail)
    if (retryAt) {
      ctx.result.retried++
      await finish(ctx.admin, [row.id], { status: 'queued', next_attempt_at: retryAt.toISOString(), last_error: detail })
    } else {
      ctx.result.failed++
      await finish(ctx.admin, [row.id], { status: 'failed', last_error: detail })
    }
  }
}

const CONCURRENCY = 5

/**
 * The notify-dispatch cron body: bounded batches inside the time budget. Every row is guarded on the state it was
 * read in, so two overlapping runs never send one row twice.
 */
export async function processOutbox(admin: Admin, budget: TimeBudget = UNBOUNDED, opts: { batch?: number; maxBatches?: number; userIds?: string[] } = {}): Promise<DispatchRunResult> {
  const result: DispatchRunResult = { ready: true, claimed: 0, sent: 0, skipped: 0, deferred: 0, retried: 0, failed: 0, fallbacks: 0, digests: 0, lost: 0 }
  const batch = opts.batch ?? 50
  const maxBatches = opts.maxBatches ?? 20
  let dlt: DltTemplates | null = null
  for (let b = 0; b < maxBatches && !budget.spent(); b++) {
    const now = new Date()
    const nowIso = now.toISOString()
    let q = admin
      .from('notification_outbox')
      .select('id, notification_id, user_id, kind, channel, payload, status, attempts, next_attempt_at, claimed_until, fallback_of, idempotency_key')
      .in('status', ['queued', 'deferred', 'sending'])
      .lte('next_attempt_at', nowIso)
      .or(`claimed_until.is.null,claimed_until.lt.${nowIso}`)
      .order('next_attempt_at', { ascending: true })
      .limit(batch)
    if (opts.userIds?.length) q = q.in('user_id', opts.userIds)
    const { data, error } = await q
    if (error) {
      if (isMissingRelation(error)) {
        markOutboxMissing('outbox read')
        return { ...result, ready: false }
      }
      throw new Error(`outbox read: ${error.message}`)
    }
    const rows = (data ?? []) as OutboxRow[]
    if (rows.length === 0) break
    // One digest per (user, channel) in a batch: the first row collects the rest.
    const seenDigest = new Set<string>()
    const work = rows.filter((r) => {
      if (!r.payload?.digest) return true
      const k = `${r.user_id}:${r.channel}`
      if (seenDigest.has(k)) return false
      seenDigest.add(k)
      return true
    })
    const userIds = [...new Set(work.map((r) => r.user_id))]
    const [users, prefs] = await Promise.all([loadRecipients(admin, userIds), loadPrefs(admin, userIds)])
    dlt ??= await loadDltTemplates(admin)
    const ctx: BatchCtx = { admin, now, users, prefs: prefs.prefs, settings: prefs.settings, dlt, result }
    for (let i = 0; i < work.length; i += CONCURRENCY) {
      if (budget.spent()) break
      await Promise.all(work.slice(i, i + CONCURRENCY).map((row) => processRow(ctx, row)))
    }
    if (rows.length < batch) break
  }
  return result
}
