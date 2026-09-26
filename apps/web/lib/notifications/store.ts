import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hhmmToMinutes, type NotificationPreference, type NotifySettingsRow } from '@amclub/shared'

/**
 * ADR-030 §4 — what the dispatcher reads about recipients, and whether migration 0087 (outbox, preferences,
 * settings, reminder claims) is on this database. Production applies 0087 after the deploy, so every reader here
 * tolerates its absence: a missing table answers "not ready" and the dispatcher keeps the direct fan-out it had
 * before, logging it once.
 */

export type TextLocale = 'en' | 'hi' | 'te' | 'ta'
export type Admin = SupabaseClient

/** Postgres 42P01 / 42703, PostgREST PGRST205 / PGRST204, or the message those carry. */
export function isMissingRelation(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false
  if (/^(42P01|42703|PGRST205|PGRST204|PGRST200)$/.test(String(error.code ?? ''))) return true
  return /does not exist|could not find/i.test(String(error.message ?? ''))
}

/** The kill switch: NOTIFY_OUTBOX=off keeps the direct fan-out even with 0087 applied. Anything else = the outbox. */
export function outboxSwitchOn(): boolean {
  return (process.env['NOTIFY_OUTBOX'] ?? 'on').toLowerCase() !== 'off'
}

// A missing 0087 is remembered for five minutes, so a busy function does not probe on every notification, and picks
// the tables up without a redeploy once the migration lands.
const MISSING_TTL_MS = 5 * 60_000
let missingSince = 0
let loggedMissing = false
export function outboxKnownMissing(): boolean {
  return missingSince > 0 && Date.now() - missingSince < MISSING_TTL_MS
}
export function markOutboxMissing(where: string): void {
  missingSince = Date.now()
  if (!loggedMissing) {
    loggedMissing = true
    console.warn(`[notify] migration 0087 is not applied (${where}) — notifications use the direct fan-out until it is`)
  }
}
export function markOutboxPresent(): void {
  missingSince = 0
}

export interface Recipient {
  id: string
  email: string | null
  phone: string | null
  locale: TextLocale
}

export function textLocaleOf(preferred: string | null | undefined): TextLocale {
  return preferred === 'hi' || preferred === 'te' || preferred === 'ta' ? preferred : 'en'
}

export async function loadRecipients(admin: Admin, userIds: string[]): Promise<Map<string, Recipient>> {
  const out = new Map<string, Recipient>()
  if (userIds.length === 0) return out
  for (let i = 0; i < userIds.length; i += 200) {
    const { data, error } = await admin.from('users').select('id, email, phone, preferred_locale').in('id', userIds.slice(i, i + 200))
    if (error) console.error('[notify] recipients', error.message)
    for (const u of (data ?? []) as { id: string; email: string | null; phone: string | null; preferred_locale: string | null }[]) {
      out.set(u.id, { id: u.id, email: u.email || null, phone: u.phone || null, locale: textLocaleOf(u.preferred_locale) })
    }
  }
  return out
}

export interface PrefsSnapshot {
  /** False when 0087 is not on this database. */
  ready: boolean
  prefs: Map<string, NotificationPreference[]>
  /** Absent = the user never saved settings (defaults: 21:00–08:00 quiet hours, no pause, no digest). */
  settings: Map<string, NotifySettingsRow>
}

export async function loadPrefs(admin: Admin, userIds: string[]): Promise<PrefsSnapshot> {
  const snap: PrefsSnapshot = { ready: true, prefs: new Map(), settings: new Map() }
  if (userIds.length === 0) return snap
  for (let i = 0; i < userIds.length; i += 200) {
    const ids = userIds.slice(i, i + 200)
    const [p, s] = await Promise.all([
      admin.from('notification_preferences').select('user_id, category, channel, enabled').in('user_id', ids),
      admin.from('notification_settings').select('user_id, quiet_start_min, quiet_end_min, paused_until, digest_leads').in('user_id', ids),
    ])
    if (isMissingRelation(p.error) || isMissingRelation(s.error)) {
      markOutboxMissing('preferences read')
      return { ready: false, prefs: new Map(), settings: new Map() }
    }
    if (p.error || s.error) console.error('[notify] preferences', p.error?.message ?? s.error?.message)
    for (const r of (p.data ?? []) as (NotificationPreference & { user_id: string })[]) {
      const list = snap.prefs.get(r.user_id) ?? []
      list.push({ category: r.category, channel: r.channel, enabled: r.enabled })
      snap.prefs.set(r.user_id, list)
    }
    for (const r of (s.data ?? []) as (NotifySettingsRow & { user_id: string })[]) {
      snap.settings.set(r.user_id, { quiet_start_min: r.quiet_start_min, quiet_end_min: r.quiet_end_min, paused_until: r.paused_until, digest_leads: !!r.digest_leads })
    }
  }
  return snap
}

/** notification_settings row from the API shape (quiet hours stored as IST minutes of the day). */
export function settingsRowFrom(input: { quietHours: { start: string; end: string } | null; pausedUntil: string | null; digestLeads: boolean }): NotifySettingsRow {
  return {
    quiet_start_min: input.quietHours ? hhmmToMinutes(input.quietHours.start) : null,
    quiet_end_min: input.quietHours ? hhmmToMinutes(input.quietHours.end) : null,
    paused_until: input.pausedUntil,
    digest_leads: input.digestLeads,
  }
}

/**
 * Claim a one-time send (a reminder stage, a refund notice) in notification_reminders: the insert is the claim and a
 * unique violation means it was sent already. 'unavailable' = 0087 is not applied.
 */
export async function claimOnce(admin: Admin, key: { kind: string; entityId: string; stage: string; userId?: string | null }): Promise<'claimed' | 'taken' | 'unavailable'> {
  const { error } = await admin.from('notification_reminders').insert({ kind: key.kind, entity_id: key.entityId, stage: key.stage, user_id: key.userId ?? null })
  if (!error) return 'claimed'
  if (error.code === '23505' || /duplicate key/i.test(error.message ?? '')) return 'taken'
  if (isMissingRelation(error)) return 'unavailable'
  console.error('[notify] claim', key.kind, key.stage, error.message)
  return 'taken'
}
