import 'server-only'
import {
  deferUntil,
  enabledChannels,
  kindSpec,
  nextDigestAt,
  planChannels,
  type ExternalChannel,
  type NotificationKind,
  type NotificationPreference,
  type NotifySettingsRow,
} from '@amclub/shared'
import { CHANNEL_HANDLERS, type ChannelResult } from './channels'
import { enqueueOutbox, loadDltTemplates, messageFor, type OutboxDraft, type OutboxPayload } from './outbox'
import type { DltTemplates } from './sms'
import { loadPrefs, loadRecipients, outboxKnownMissing, outboxSwitchOn, type Admin, type Recipient, type TextLocale } from './store'

/**
 * `notification.dispatch` (§5.9, ADR-030 §4). A call site names the KIND; the registry (shared NOTIFICATION_KINDS),
 * the recipient's preferences and the essential floor decide the channels — call sites no longer pick them.
 *
 *   1. The in-app row is written first (the notification centre and the bell are the record), as before.
 *   2. Every external send becomes a `notification_outbox` row keyed `${notificationId}:${channel}`, processed by the
 *      per-minute cron `notify-dispatch` with retry and backoff. Non-urgent rows wait out quiet hours (IST) and a
 *      pause; a provider on the lead digest gets `rfq_matched` at the next 09:00 IST as one message. WhatsApp
 *      eligibility (consent, STOP, suppression, the window) is decided by agent-core `sendWhatsApp` at send time; a
 *      WhatsApp that does not deliver hands over to SMS / email (the plan's fallback).
 *   3. Without migration 0087 (or with NOTIFY_OUTBOX=off) the external channels are sent directly, as before 0087,
 *      with the same fallback — logged once.
 * Never throws: a notification never fails the action that caused it.
 */

type I18n = { en: string; hi: string; te?: string; ta?: string }
/** A value for a template parameter: plain, or per locale (a date in IST, a label). */
export type NotifyValue = string | number | I18n | null | undefined

export interface NotificationInput {
  userId: string
  kind: NotificationKind
  titleI18n: I18n
  bodyI18n: I18n
  link?: string
  /** Typed template parameters (ref, amount, deadline …) for WhatsApp / SMS templates; formatted on the server. */
  values?: Record<string, NotifyValue>
  /**
   * The channels, chosen by the caller instead of the registry. ONLY for documented system callers: support replies
   * going back on the channel the user wrote on (support_escalated / support_resolved) and the ops ticket ping held
   * in the ops quiet hours (support_ticket_opened).
   */
  channels?: readonly ExternalChannel[]
}

const resolve = (t: I18n, l: TextLocale): string => t[l] ?? t.en

function resolveValues(values: Record<string, NotifyValue> | undefined, l: TextLocale): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(values ?? {})) {
    if (v == null) continue
    out[k] = typeof v === 'object' ? resolve(v, l) : String(v)
  }
  return out
}

interface Plan {
  userId: string
  user: Recipient | undefined
  now: ExternalChannel[]
  fallback: ExternalChannel[]
  /** What the in-app row records as its channels (the preference-level choice + any fallback). */
  recorded: string[]
}

/** Push has no subscription store in V1: never queued. */
const sendable = (c: ExternalChannel) => c !== 'push'

function planFor(kind: string, input: Omit<NotificationInput, 'userId'>, userId: string, user: Recipient | undefined, prefs: NotificationPreference[]): Plan {
  const spec = kindSpec(kind)
  const hasEmail = !!user?.email
  const hasPhone = !!user?.phone
  if (input.channels) {
    const chosen = input.channels.filter(sendable)
    const reach = chosen.filter((c) => (c === 'email' ? hasEmail : hasPhone))
    return { userId, user, now: reach, fallback: [], recorded: ['in_app', ...chosen] }
  }
  const p = planChannels(spec, prefs, hasEmail, hasPhone)
  const now = p.now.filter(sendable)
  const fallback = p.fallback.filter(sendable)
  const recorded = ['in_app', ...new Set([...enabledChannels(spec, prefs).filter(sendable), ...now, ...fallback])]
  return { userId, user, now, fallback, recorded }
}

async function insertInApp(admin: Admin, kind: string, input: Omit<NotificationInput, 'userId'>, plans: Plan[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  try {
    // supabase-js reports a failed insert in `error` (it does not throw) — log it with context.
    const { data, error } = await admin
      .from('notifications')
      .insert(plans.map((p) => ({ user_id: p.userId, kind, title_i18n: input.titleI18n, body_i18n: input.bodyI18n, link: input.link ?? null, channels: p.recorded })))
      .select('id, user_id')
    if (error) console.error('[createNotification:in_app] insert failed', { kind, recipients: plans.length, code: error.code, message: error.message })
    for (const r of (data ?? []) as { id: string; user_id: string }[]) ids.set(r.user_id, r.id)
  } catch (e) {
    console.error('[createNotification:in_app]', e)
  }
  return ids
}

function payloadFor(input: Omit<NotificationInput, 'userId'>, locale: TextLocale): OutboxPayload {
  return {
    v: 1,
    locale,
    title: resolve(input.titleI18n, locale),
    body: resolve(input.bodyI18n, locale),
    link: input.link ?? null,
    values: resolveValues(input.values, locale),
    ...(input.channels ? { override: true } : {}),
  }
}

function draftsFor(kind: string, input: Omit<NotificationInput, 'userId'>, plan: Plan, notificationId: string | null, keyId: string, settings: NotifySettingsRow | undefined, at: Date): OutboxDraft[] {
  const spec = kindSpec(kind)
  const locale = plan.user?.locale ?? 'en'
  const base = payloadFor(input, locale)
  const digest = !!spec.digest && !!settings?.digest_leads && !input.channels
  return plan.now.map((channel) => {
    const payload: OutboxPayload = { ...base, ...(channel === 'whatsapp' && plan.fallback.length ? { fallback: plan.fallback } : {}), ...(digest ? { digest: true } : {}) }
    const wait = digest ? nextDigestAt(at) : deferUntil(at, settings ?? null, spec, channel)
    return {
      notificationId,
      keyId,
      userId: plan.userId,
      kind,
      channel,
      payload,
      status: wait ? 'deferred' : 'queued',
      nextAttemptAt: (wait ?? at).toISOString(),
    }
  })
}

/** Before 0087 / with the kill switch: each channel is sent now, and a WhatsApp that did not go hands over. */
async function sendDirect(admin: Admin, kind: string, input: Omit<NotificationInput, 'userId'>, plans: Plan[], ids: Map<string, string>): Promise<void> {
  const needsDlt = plans.some((p) => p.now.includes('sms') || p.fallback.includes('sms'))
  const dltTemplates: DltTemplates = needsDlt ? await loadDltTemplates(admin) : {}
  const ctx = { admin, dltTemplates }
  const failures: ChannelResult[] = []
  await Promise.all(
    plans.map(async (plan) => {
      if (plan.now.length === 0) return
      const notificationId = ids.get(plan.userId) ?? null
      const keyId = notificationId ?? crypto.randomUUID()
      const locale = plan.user?.locale ?? 'en'
      const payload = payloadFor(input, locale)
      const msgFor = (channel: ExternalChannel) =>
        messageFor({ notification_id: notificationId, user_id: plan.userId, kind, idempotency_key: `${keyId}:${channel}` }, payload, plan.user)
      const safe = (channel: ExternalChannel) =>
        CHANNEL_HANDLERS[channel](msgFor(channel), ctx).catch((e): ChannelResult => ({ channel, outcome: 'failed', detail: `error:${(e as Error).message}` }))
      const results = await Promise.all(plan.now.map(safe))
      const wa = results.find((r) => r.channel === 'whatsapp')
      if (wa && wa.fallback && (wa.outcome === 'skipped' || wa.outcome === 'failed')) {
        for (const ch of plan.fallback) {
          if (plan.now.includes(ch)) continue
          if (ch === 'sms' && !dltTemplates[kind]) continue
          results.push(await safe(ch))
        }
      }
      failures.push(...results.filter((r) => r.outcome === 'failed'))
    }),
  )
  if (failures.length > 0) console.warn('[notify:direct] channel failures', failures.map((f) => `${f.channel} ${f.detail}`))
}

async function dispatch(admin: Admin, userIds: string[], input: Omit<NotificationInput, 'userId'>): Promise<void> {
  const kind = input.kind
  const at = new Date()
  const useOutbox = outboxSwitchOn() && !outboxKnownMissing()
  const [users, store] = await Promise.all([
    loadRecipients(admin, userIds),
    useOutbox ? loadPrefs(admin, userIds) : Promise.resolve({ ready: false, prefs: new Map<string, NotificationPreference[]>(), settings: new Map<string, NotifySettingsRow>() }),
  ])
  const plans = userIds.map((uid) => planFor(kind, input, uid, users.get(uid), store.prefs.get(uid) ?? []))
  const ids = await insertInApp(admin, kind, input, plans)
  const external = plans.filter((p) => p.now.length > 0)
  if (external.length === 0) return

  if (useOutbox && store.ready) {
    const drafts = external.flatMap((p) => {
      const notificationId = ids.get(p.userId) ?? null
      return draftsFor(kind, input, p, notificationId, notificationId ?? crypto.randomUUID(), store.settings.get(p.userId), at)
    })
    const r = await enqueueOutbox(admin, drafts)
    if (r === 'ok') return
    // 'missing' (0087 not applied) or an insert error: nothing was queued (one statement), so send directly.
  }
  await sendDirect(admin, kind, input, external, ids)
}

/** One recipient. Best-effort; never throws. */
export async function createNotification(admin: Admin, input: NotificationInput): Promise<void> {
  try {
    await dispatch(admin, [input.userId], input)
  } catch (e) {
    console.error('[createNotification]', input.kind, e)
  }
}

/** Many recipients of the same notification (an RFQ fan-out). Best-effort; never throws. */
export async function createNotificationsBulk(admin: Admin, userIds: string[], base: Omit<NotificationInput, 'userId'>): Promise<void> {
  const unique = [...new Set(userIds.filter(Boolean))]
  if (unique.length === 0) return
  try {
    for (let i = 0; i < unique.length; i += 200) await dispatch(admin, unique.slice(i, i + 200), base)
  } catch (e) {
    console.error('[createNotificationsBulk]', base.kind, e)
  }
}
