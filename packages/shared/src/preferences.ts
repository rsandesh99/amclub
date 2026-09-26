import { z } from 'zod'
import { SUPPORTED_LOCALES } from './locales'
import type { ExternalChannel, NotificationCategory, NotificationPreference } from './notify'

/** N33 — display density (PRD §3.5). NULL/absent = the role default. */
export const UI_DENSITIES = ['comfortable', 'compact'] as const
export type UiDensity = (typeof UI_DENSITIES)[number]

/**
 * PATCH /api/v1/profile/preferences — the caller's own display preferences. Each field is optional; a patch names at
 * least one. `preferredLocale` (audit §5 item 10): the header language switch on the web and the mobile toggle persist
 * the choice to the account, so email, SMS and WhatsApp follow the language the person reads.
 */
export const preferencesPatchSchema = z
  .object({
    uiDensity: z.enum(UI_DENSITIES).nullable().optional(),
    preferredLocale: z.enum(SUPPORTED_LOCALES).optional(),
  })
  .refine((v) => v.uiDensity !== undefined || v.preferredLocale !== undefined, { message: 'empty_patch' })
export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>

/** The density a surface renders with: the user's choice, else the surface default. */
export function resolveDensity(pref: UiDensity | null | undefined, surface: 'buyer' | 'provider' | 'admin'): UiDensity {
  if (pref) return pref
  return surface === 'buyer' ? 'comfortable' : 'compact'
}

// ── Notification settings screens (web + mobile; PRD_WHATSAPP W1) ────────────
// The contract is notify.ts (notificationSettingsSchema). These helpers are the screens' shared behaviour, so the web
// page and the mobile screen offer the same choices and apply the same essential-channel rule before the server does.

/** Channels a person can switch on the settings screens (push is shown as "coming soon", never switchable yet). */
export const SWITCHABLE_CHANNELS = ['email', 'sms', 'whatsapp'] as const satisfies readonly ExternalChannel[]
export type SwitchableChannel = (typeof SWITCHABLE_CHANNELS)[number]

/** Quiet-hours choices (IST), the suggested 21:00–08:00 window among them. */
export const QUIET_HOURS_START_CHOICES = ['20:00', '21:00', '22:00', '23:00'] as const
export const QUIET_HOURS_END_CHOICES = ['06:00', '07:00', '08:00', '09:00'] as const
/** "Pause for N days" choices. */
export const PAUSE_DAY_CHOICES = [1, 3, 7, 14] as const

/**
 * The switch a settings screen shows for (category, channel): the row the server sent, else a fallback. The GET fills
 * every row from the notification registry; the fallback only covers a row it did not send (on for email / SMS /
 * WhatsApp, off for offers and product news, off for push).
 */
export function channelEnabled(prefs: readonly NotificationPreference[], category: NotificationCategory, channel: ExternalChannel): boolean {
  const row = prefs.find((p) => p.category === category && p.channel === channel)
  if (row) return row.enabled
  return channel !== 'push' && category !== 'updates'
}

/** `prefs` with (category, channel) set to `enabled` (the row replaced, or added). */
export function withChannel(prefs: readonly NotificationPreference[], category: NotificationCategory, channel: ExternalChannel, enabled: boolean): NotificationPreference[] {
  const rest = prefs.filter((p) => !(p.category === category && p.channel === channel))
  return [...rest, { category, channel, enabled }]
}

/**
 * Essential categories (money and deadlines) keep at least one of email / SMS / WhatsApp on. The screens refuse the
 * change that would switch off the last one (the PUT answers 422 essential_needs_channel for the same thing).
 */
export function essentialChannelMissing(prefs: readonly NotificationPreference[], essential: readonly NotificationCategory[]): NotificationCategory | null {
  for (const category of essential) {
    if (!SWITCHABLE_CHANNELS.some((c) => channelEnabled(prefs, category, c))) return category
  }
  return null
}

/** 08:00 IST on the day `days` days after today (IST) — a pause ends in the morning, not at midnight. */
export function pauseUntilIso(days: number, now: Date): string {
  const IST_MS = 330 * 60_000
  const ist = new Date(now.getTime() + IST_MS)
  const endUtcMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + days, 8, 0) - IST_MS
  return new Date(endUtcMs).toISOString()
}

/** True while a stored pause is still in the future. */
export function isPaused(pausedUntil: string | null | undefined, now: Date): boolean {
  if (!pausedUntil) return false
  const t = Date.parse(pausedUntil)
  return Number.isFinite(t) && t > now.getTime()
}
