import { z } from 'zod'
import type { WaConsentPurpose } from './whatsapp'

/**
 * Notification contract (ADR-030 §4, PRD_WHATSAPP W1): the ONE event → channel registry, the user's preferences and
 * quiet hours. The dispatcher (apps/web/lib/notifications) reads NOTIFICATION_KINDS; a kind that is not registered
 * sends in-app only. Channel choice per call site is gone: a call site names the kind, the registry and the user's
 * preferences decide the channels.
 */

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'sms', 'whatsapp', 'push'] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]
/** Channels a user can switch per category (in-app is always on: it is the record). */
export const EXTERNAL_CHANNELS = ['email', 'sms', 'whatsapp', 'push'] as const
export type ExternalChannel = (typeof EXTERNAL_CHANNELS)[number]

export const NOTIFICATION_CATEGORIES = [
  'orders', // order lifecycle, delivery, disputes, refunds
  'payments', // payment received, refund processed, payout paid / held
  'requests', // RFQ: matched leads (provider), new quotes (buyer), clarifications
  'reminders', // deadlines: accept-by, review-by, quote / request expiring, pay-by
  'account', // verification, KYC, security, legal
  'assistant', // the AMClub assistant writing first (Munshi drafts, procurement updates)
  'updates', // product news and offers (marketing; never without its own consent)
] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

export interface NotificationKindSpec {
  category: NotificationCategory
  /** Channels used when the user has no preference row for the category. */
  defaultChannels: readonly ExternalChannel[]
  /** Essential: the user may pick channels but cannot silence every external channel for it (money and deadlines). */
  essential: boolean
  /** Sent even inside quiet hours / a pause (a deadline within hours, money moved). */
  urgent: boolean
  /** The WhatsApp consent purpose this kind needs. */
  waPurpose: WaConsentPurpose
  /** SMS is sent only as a fallback (WhatsApp failed / not opted in), never alongside a delivered WhatsApp. */
  smsFallbackOnly?: boolean
}

/** Preferences: one row per (category, channel) the user changed; absent = the kind's default. */
export const notificationPreferenceSchema = z.object({
  category: z.enum(NOTIFICATION_CATEGORIES),
  channel: z.enum(EXTERNAL_CHANNELS),
  enabled: z.boolean(),
})
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const notificationSettingsSchema = z.object({
  preferences: z.array(notificationPreferenceSchema).max(NOTIFICATION_CATEGORIES.length * EXTERNAL_CHANNELS.length),
  /** IST wall-clock window, e.g. { start: '21:00', end: '08:00' }; null = no quiet hours. */
  quietHours: z.object({ start: hhmm, end: hhmm }).nullable(),
  /** Non-urgent external notifications wait until this time (a holiday pause); null = not paused. */
  pausedUntil: z.string().datetime({ offset: true }).nullable(),
  /** Providers: new-lead alerts as one morning digest instead of one message each. */
  digestLeads: z.boolean(),
})
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>
export type NotificationPreference = z.infer<typeof notificationPreferenceSchema>

export const DEFAULT_QUIET_HOURS = { start: '21:00', end: '08:00' } as const

const IST_OFFSET_MIN = 330
function minutesOf(hm: string): number {
  const [h, m] = hm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}
/** IST minute-of-day for a UTC instant. */
export function istMinuteOfDay(at: Date): number {
  return (((at.getUTCHours() * 60 + at.getUTCMinutes() + IST_OFFSET_MIN) % 1440) + 1440) % 1440
}
/** True when `at` falls inside the IST window [start, end); a window may cross midnight (21:00 → 08:00). */
export function inQuietHours(at: Date, window: { start: string; end: string } | null): boolean {
  if (!window) return false
  const s = minutesOf(window.start)
  const e = minutesOf(window.end)
  if (s === e) return false
  const now = istMinuteOfDay(at)
  return s < e ? now >= s && now < e : now >= s || now < e
}
/** The UTC instant the current quiet window ends (for deferring a send); `at` itself when not inside the window. */
export function quietHoursEnd(at: Date, window: { start: string; end: string } | null): Date {
  if (!inQuietHours(at, window) || !window) return at
  const now = istMinuteOfDay(at)
  const e = minutesOf(window.end)
  const wait = ((e - now) % 1440 + 1440) % 1440
  return new Date(Math.floor(at.getTime() / 60000) * 60000 + wait * 60000)
}

// ── The registry (ADR-030 §4) ─────────────────────────────────────────────────
// One row per kind the web creates. Money and deadline kinds are essential (they keep a channel whatever the user
// switched off); urgent kinds ignore quiet hours and a pause (a deadline within hours, the buyer's own receipt).
// SMS is a fallback for WhatsApp (smsFallbackOnly) wherever both are listed: it costs money and needs a DLT template.
// Kinds with no default channel are in-app only and stay so whatever the preferences say (deliberately quiet kinds,
// or kinds the agent runtime sends on WhatsApp itself). A kind only the runtime sends (support_reply, munshi_draft,
// procurement_update, onboarding_*) is not listed: it never passes through the web dispatcher.

export interface NotificationKindSpecExt extends NotificationKindSpec {
  /** Providers who chose the lead digest get this kind collapsed into one 09:00 IST message (rfq_matched). */
  digest?: boolean
}

const WA_EMAIL: readonly ExternalChannel[] = ['whatsapp', 'email']
const WA_EMAIL_SMS: readonly ExternalChannel[] = ['whatsapp', 'email', 'sms']

/** A kind that must always reach the user (money, deadlines), with SMS as the WhatsApp fallback. */
const essentialKind = (category: NotificationCategory, urgent = false, channels: readonly ExternalChannel[] = WA_EMAIL_SMS): NotificationKindSpecExt =>
  ({ category, defaultChannels: channels, essential: true, urgent, waPurpose: 'transactional', ...(channels.includes('sms') ? { smsFallbackOnly: true } : {}) })
/** An ordinary update (WhatsApp + email unless named). */
const updateKind = (category: NotificationCategory, channels: readonly ExternalChannel[] = WA_EMAIL, waPurpose: WaConsentPurpose = 'transactional'): NotificationKindSpecExt =>
  ({ category, defaultChannels: channels, essential: false, urgent: false, waPurpose, ...(channels.includes('sms') ? { smsFallbackOnly: true } : {}) })
/** In-app only (the bell and the notification centre). */
const inAppKind = (category: NotificationCategory, waPurpose: WaConsentPurpose = 'transactional'): NotificationKindSpecExt =>
  ({ category, defaultChannels: [], essential: false, urgent: false, waPurpose })

export const NOTIFICATION_KINDS = {
  // ── orders ──────────────────────────────────────────────────────────────────
  /** Provider: a paid order to accept within 24 h (the clock runs). Buyer: their own payment receipt. */
  order_placed: essentialKind('orders', true),
  order_accepted: updateKind('orders'),
  requirements_submitted: updateKind('orders'),
  order_in_progress: updateKind('orders'),
  /** Starts the 72-hour auto-accept. */
  order_delivered: essentialKind('orders'),
  order_completed: updateKind('orders'),
  order_auto_accepted: updateKind('orders'),
  order_cancelled: updateKind('orders'),
  /** The buyer was refunded in full; the provider lost the order. */
  order_auto_cancelled: essentialKind('orders'),
  /** Money stops until the dispute is resolved. */
  order_disputed: essentialKind('orders', false, WA_EMAIL),
  revision_requested: updateKind('orders'),
  milestone_added: updateKind('orders'),
  review_prompt: updateKind('orders', ['email']),
  review_reply: updateKind('orders', ['email']),
  /** Never the message text (E8b): the order number only. */
  order_message: updateKind('orders', ['whatsapp']),
  order_nudge: updateKind('orders', ['whatsapp']),
  dispute_statement: updateKind('orders'),
  /** The outcome and any refund amount, to both parties. */
  dispute_resolved: essentialKind('orders'),
  goods_dispatched: updateKind('orders'),
  /** Goods: the delivery photo starts the 72-hour receipt window. */
  goods_delivered: essentialKind('orders'),
  // AMC Mart pools (M1, pay-on-close).
  /** Member: pay your share by the deadline or the commitment lapses. */
  pool_met: essentialKind('orders', true),
  pool_unmet: updateKind('orders'),
  pool_cancelled: updateKind('orders'),
  pool_defaulted: updateKind('orders', ['email']),
  pool_met_seller: updateKind('orders'),
  pool_ordered: updateKind('orders'),

  // ── payments ────────────────────────────────────────────────────────────────
  payout_paid: essentialKind('payments'),
  payout_held: essentialKind('payments', false, WA_EMAIL),
  refund_processed: essentialKind('payments'),
  refund_failed: essentialKind('payments'),
  order_duplicate_payment: essentialKind('payments'),
  payment_refunded_no_order: essentialKind('payments'),

  // ── requests ────────────────────────────────────────────────────────────────
  /** Provider leads: one message each, or one 09:00 IST digest for providers who chose it. */
  rfq_matched: { ...updateKind('requests', ['whatsapp', 'sms']), digest: true },
  /** The collapsed lead digest the dispatcher sends (no call site creates it). */
  rfq_digest: updateKind('requests', ['whatsapp', 'sms']),
  rfq_new_quote: updateKind('requests', WA_EMAIL_SMS),
  quote_revised: updateKind('requests'),
  quote_withdrawn: updateKind('requests'),
  quote_accepted: updateKind('requests', WA_EMAIL_SMS),
  /** The buyer declined this provider's quote (S1.2 decline message). */
  quote_declined: updateKind('requests', ['whatsapp']),
  /** The request went to another provider. */
  quote_lost: inAppKind('requests'),
  quote_expired: inAppKind('requests'),
  quote_message: inAppKind('requests'),
  rfq_question: updateKind('requests', ['whatsapp']),
  rfq_answer: updateKind('requests', ['whatsapp']),
  rfq_providers_unavailable: updateKind('requests', ['email']),
  rfq_expired: updateKind('requests', ['email']),
  rfq_sent_as_is: inAppKind('requests'),
  rfq_nudge: updateKind('requests', ['whatsapp']),
  // S3.4 group requests for services: in-app (the assistant programme owns their WhatsApp later).
  pool_invite: inAppKind('requests', 'assistant'),
  pool_open: inAppKind('requests', 'assistant'),
  pool_opened_buyer: inAppKind('requests', 'assistant'),
  pool_offer: inAppKind('requests', 'assistant'),
  pool_offer_withdrawn: inAppKind('requests', 'assistant'),
  pool_quote: inAppKind('requests', 'assistant'),
  pool_closed_provider: inAppKind('requests', 'assistant'),
  pool_ended: inAppKind('requests', 'assistant'),
  pool_lapsed: inAppKind('requests', 'assistant'),

  // ── reminders (cron notify-reminders) ───────────────────────────────────────
  /** Provider: accept within hours or the order is cancelled and refunded. */
  order_accept_reminder: essentialKind('reminders', true),
  /** Buyer: review the delivery (or confirm receipt) before the 72-hour auto-accept. */
  order_review_reminder: essentialKind('reminders'),
  /** Buyer: a request with quotes waiting closes within 12 hours. */
  rfq_expiring_reminder: essentialKind('reminders', true),
  /** Mart member: pay the pool share before the deadline. */
  pool_pay_reminder: essentialKind('reminders', true),
  licence_renewal_due: updateKind('reminders', ['whatsapp'], 'assistant'),
  mart_reorder_reminder: inAppKind('reminders'),

  // ── account ─────────────────────────────────────────────────────────────────
  provider_verified: essentialKind('account'),
  provider_rejected: essentialKind('account'),
  provider_needs_info: essentialKind('account'),
  onboarding_stalled: updateKind('account', ['whatsapp'], 'assistant'),
  /** Support answers go back on the channel the user used: the caller passes it (documented override). */
  support_escalated: inAppKind('account'),
  support_resolved: inAppKind('account'),
  /** Ops: a new support ticket (the caller holds WhatsApp during the ops quiet hours). */
  support_ticket_opened: updateKind('account'),

  // ── assistant ───────────────────────────────────────────────────────────────
  // Munshi's own WhatsApp messages come from the agent runtime; the web writes the in-app row only.
  munshi_window_warning: inAppKind('assistant', 'assistant'),
  munshi_growth: inAppKind('assistant', 'assistant'),
  munshi_draft_ready: inAppKind('assistant', 'assistant'),
  /** Ops: AI cards for the founder's one tap (the founder's own assistant opt-in). */
  dispute_triage_ready: updateKind('assistant', WA_EMAIL, 'assistant'),
  payout_dossier_ready: updateKind('assistant', WA_EMAIL, 'assistant'),
} as const satisfies Record<string, NotificationKindSpecExt>

export type NotificationKind = keyof typeof NOTIFICATION_KINDS
export const NOTIFICATION_KIND_NAMES = Object.keys(NOTIFICATION_KINDS) as NotificationKind[]

export function isNotificationKind(kind: string): kind is NotificationKind {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_KINDS, kind)
}

/** An unregistered kind: in-app only, never an external channel. */
const UNREGISTERED: NotificationKindSpecExt = { category: 'updates', defaultChannels: [], essential: false, urgent: false, waPurpose: 'transactional' }

/** The spec for a kind; an unknown kind sends in-app only. */
export function kindSpec(kind: string): NotificationKindSpecExt {
  return isNotificationKind(kind) ? NOTIFICATION_KINDS[kind] : UNREGISTERED
}

/** Channels the preferences screen offers (push has no subscription store in V1). */
export const PREFERENCE_CHANNELS = ['whatsapp', 'sms', 'email'] as const satisfies readonly ExternalChannel[]
export type PreferenceChannel = (typeof PREFERENCE_CHANNELS)[number]

type PrefLookup = readonly Pick<NotificationPreference, 'category' | 'channel' | 'enabled'>[]
const prefFor = (prefs: PrefLookup, category: NotificationCategory, channel: ExternalChannel): boolean | undefined =>
  prefs.find((p) => p.category === category && p.channel === channel)?.enabled

/** A category's default for a channel: on when any kind in the category defaults to it. */
export function categoryDefault(category: NotificationCategory, channel: ExternalChannel): boolean {
  return NOTIFICATION_KIND_NAMES.some((k) => {
    const s: NotificationKindSpec = NOTIFICATION_KINDS[k]
    return s.category === category && s.defaultChannels.includes(channel)
  })
}

/** Categories that hold an essential kind: the user picks channels there but cannot switch every one off. */
export function essentialCategories(): NotificationCategory[] {
  return NOTIFICATION_CATEGORIES.filter((c) => NOTIFICATION_KIND_NAMES.some((k) => NOTIFICATION_KINDS[k].category === c && NOTIFICATION_KINDS[k].essential))
}

/**
 * The channels the preferences switch on for a kind, before reachability: the user's row for the kind's category
 * when there is one, else the kind's default. A kind with no default channel stays in-app only.
 */
export function enabledChannels(spec: NotificationKindSpec, prefs: PrefLookup): ExternalChannel[] {
  if (spec.defaultChannels.length === 0) return []
  return EXTERNAL_CHANNELS.filter((c) => prefFor(prefs, spec.category, c) ?? spec.defaultChannels.includes(c))
}

/**
 * The external channels a notification goes out on for one recipient: the enabled channels the recipient can be
 * reached on (email needs an address; SMS and WhatsApp a phone), with the essential floor — an essential kind whose
 * every channel is off (or unreachable) keeps email when the user has one, else SMS.
 */
export function channelsFor(spec: NotificationKindSpec, prefs: PrefLookup, hasEmail: boolean, hasPhone: boolean): ExternalChannel[] {
  const reachable = (c: ExternalChannel) => (c === 'email' ? hasEmail : c === 'push' ? true : hasPhone)
  const out = enabledChannels(spec, prefs).filter(reachable)
  if (spec.essential && !out.some((c) => c !== 'push')) {
    if (hasEmail) out.push('email')
    else if (hasPhone) out.push('sms')
  }
  return out
}

/**
 * What to send now, and what to hold as the fallback for a WhatsApp that does not deliver:
 *  - SMS on a smsFallbackOnly kind goes only when WhatsApp did not (never beside a delivered WhatsApp);
 *  - an essential kind whose only channel now is WhatsApp falls back to SMS and email (ADR-030 §4).
 * Without WhatsApp in `now` there is nothing to fall back from, so SMS goes at once.
 */
export function planChannels(spec: NotificationKindSpec, prefs: PrefLookup, hasEmail: boolean, hasPhone: boolean): { now: ExternalChannel[]; fallback: ExternalChannel[] } {
  const chosen = channelsFor(spec, prefs, hasEmail, hasPhone)
  if (!chosen.includes('whatsapp')) return { now: chosen, fallback: [] }
  let now = chosen
  const fallback: ExternalChannel[] = []
  if (spec.smsFallbackOnly && chosen.includes('sms')) {
    now = chosen.filter((c) => c !== 'sms')
    fallback.push('sms')
  }
  if (spec.essential && !now.some((c) => c !== 'whatsapp' && c !== 'push')) {
    if (hasPhone && !fallback.includes('sms')) fallback.push('sms')
    if (hasEmail) fallback.push('email')
  }
  return { now, fallback }
}

// ── Deferral: quiet hours, pause, the lead digest ─────────────────────────────

/** A recipient's notification_settings row as the dispatcher reads it (no row = the defaults). */
export interface NotifySettingsRow {
  quiet_start_min: number | null
  quiet_end_min: number | null
  paused_until: string | null
  digest_leads: boolean
}

export function minutesToHhmm(min: number): string {
  const m = ((Math.trunc(min) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
export function hhmmToMinutes(hm: string): number {
  return minutesOf(hm)
}

/** The quiet window a settings row stands for: no row = the default 21:00–08:00; a row with nulls = none. */
export function quietWindowOf(row: NotifySettingsRow | null | undefined): { start: string; end: string } | null {
  if (!row) return { ...DEFAULT_QUIET_HOURS }
  if (row.quiet_start_min == null || row.quiet_end_min == null) return null
  return { start: minutesToHhmm(row.quiet_start_min), end: minutesToHhmm(row.quiet_end_min) }
}

/** Quiet hours hold what would buzz a phone; email is silent and goes at once. A pause holds every external channel. */
export const QUIET_HOURS_CHANNELS: readonly ExternalChannel[] = ['whatsapp', 'sms', 'push']

/**
 * When a non-urgent send must wait: past a pause, then past the quiet window at that moment. Null = send now.
 * Urgent kinds never wait.
 */
export function deferUntil(at: Date, row: NotifySettingsRow | null | undefined, spec: Pick<NotificationKindSpec, 'urgent'>, channel: ExternalChannel): Date | null {
  if (spec.urgent) return null
  let t = at
  const paused = row?.paused_until ? new Date(row.paused_until) : null
  if (paused && Number.isFinite(paused.getTime()) && paused.getTime() > t.getTime()) t = paused
  if (QUIET_HOURS_CHANNELS.includes(channel)) t = quietHoursEnd(t, quietWindowOf(row))
  return t.getTime() > at.getTime() ? t : null
}

/** The lead digest goes at 09:00 IST. */
export const NOTIFY_DIGEST_MINUTE_IST = 9 * 60

/** The next 09:00 IST strictly after `at`. */
export function nextDigestAt(at: Date): Date {
  let wait = (NOTIFY_DIGEST_MINUTE_IST - istMinuteOfDay(at) + 1440) % 1440
  if (wait === 0) wait = 1440
  return new Date(Math.floor(at.getTime() / 60000) * 60000 + wait * 60000)
}

// ── Outbox retry ─────────────────────────────────────────────────────────────

/** Minutes to wait after the 1st, 2nd, 3rd and 4th failed attempt; the 5th failure is final. */
export const OUTBOX_BACKOFF_MINUTES = [1, 5, 15, 60] as const
export const OUTBOX_MAX_ATTEMPTS = 5
/** A claimed row is locked this long (each send has its own 5–10 s timeout). */
export const OUTBOX_CLAIM_MS = 2 * 60_000

/** The next attempt after `attempts` tries failed, or null when that was the last one. */
export function outboxRetryAt(at: Date, attempts: number): Date | null {
  if (attempts >= OUTBOX_MAX_ATTEMPTS) return null
  const i = Math.min(Math.max(attempts, 1), OUTBOX_BACKOFF_MINUTES.length) - 1
  return new Date(at.getTime() + OUTBOX_BACKOFF_MINUTES[i]! * 60_000)
}

/** One outbox row per notification and channel; a fallback reuses its channel's key, so it is never doubled. */
export const outboxKey = (notificationId: string, channel: ExternalChannel): string => `${notificationId}:${channel}`

// ── Preferences API (GET / PUT /api/v1/me/notification-preferences) ──────────

export interface NotificationPreferencesResponse {
  /** `preferences` is the full category × PREFERENCE_CHANNELS matrix, defaults filled in. */
  settings: NotificationSettings
  /** False until migration 0087 is applied: the screen shows the defaults and saving answers 503 not_ready. */
  ready: boolean
  essentialCategories: NotificationCategory[]
}

/** The full matrix a user sees: their rows over the category defaults. */
export function effectivePreferences(prefs: PrefLookup): NotificationPreference[] {
  const out: NotificationPreference[] = []
  for (const category of NOTIFICATION_CATEGORIES) {
    for (const channel of PREFERENCE_CHANNELS) out.push({ category, channel, enabled: prefFor(prefs, category, channel) ?? categoryDefault(category, channel) })
  }
  return out
}

/** Essential categories a preference set would leave with no external channel (the PUT answers 422 essential_needs_channel). */
export function essentialCategoriesWithoutChannel(prefs: PrefLookup): NotificationCategory[] {
  return essentialCategories().filter((category) => !PREFERENCE_CHANNELS.some((c) => prefFor(prefs, category, c) ?? categoryDefault(category, c)))
}

/** The longest pause a user may set. */
export const NOTIFY_MAX_PAUSE_DAYS = 90
