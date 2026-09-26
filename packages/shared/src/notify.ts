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
