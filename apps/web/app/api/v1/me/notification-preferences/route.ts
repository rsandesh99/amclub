import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import {
  NOTIFY_MAX_PAUSE_DAYS,
  PREFERENCE_CHANNELS,
  categoryDefault,
  effectivePreferences,
  essentialCategories,
  essentialCategoriesWithoutChannel,
  notificationSettingsSchema,
  quietWindowOf,
  type NotificationPreference,
  type NotificationPreferencesResponse,
  type NotifySettingsRow,
} from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { captureServerEvent } from '@/lib/analytics/server'
import { serverError } from '@/lib/api/errors'
import { isMissingRelation, settingsRowFrom } from '@/lib/notifications/store'

export const dynamic = 'force-dynamic'

/**
 * ADR-030 §4 — the signed-in person's notification choices (web settings, mobile).
 *
 * GET → NotificationPreferencesResponse: `settings.preferences` is the full category × channel (whatsapp / sms /
 * email) matrix with the defaults filled in; quiet hours are IST HH:MM (no saved row = the default 21:00–08:00; null =
 * none); `essentialCategories` are the ones that must keep at least one channel. Before migration 0087 it answers the
 * defaults with `ready: false`.
 *
 * PUT (notificationSettingsSchema) replaces the choices: a preference equal to the category default is stored as no
 * row (so a later default change reaches the user), quiet hours are stored as IST minutes of the day, a pause is at
 * most 90 days. 422 `essential_needs_channel` when an essential category would be left with no channel; 503
 * `not_ready` before 0087. The person's own session only (never a delegated agent token); rate limited.
 */

const noStore = { 'Cache-Control': 'private, no-store' }

function body(prefs: NotificationPreference[], row: NotifySettingsRow | null, ready: boolean): NotificationPreferencesResponse {
  const paused = row?.paused_until && new Date(row.paused_until).getTime() > Date.now() ? new Date(row.paused_until).toISOString() : null
  return {
    settings: { preferences: effectivePreferences(prefs), quietHours: quietWindowOf(row), pausedUntil: paused, digestLeads: !!row?.digest_leads },
    ready,
    essentialCategories: essentialCategories(),
  }
}

async function load(userId: string): Promise<{ ready: boolean; prefs: NotificationPreference[]; row: NotifySettingsRow | null }> {
  const admin = await createAdminClient()
  const [p, s] = await Promise.all([
    admin.from('notification_preferences').select('category, channel, enabled').eq('user_id', userId),
    admin.from('notification_settings').select('quiet_start_min, quiet_end_min, paused_until, digest_leads').eq('user_id', userId).maybeSingle(),
  ])
  if (isMissingRelation(p.error) || isMissingRelation(s.error)) return { ready: false, prefs: [], row: null }
  if (p.error || s.error) throw new Error(p.error?.message ?? s.error?.message ?? 'read failed')
  return { ready: true, prefs: (p.data ?? []) as NotificationPreference[], row: (s.data as NotifySettingsRow | null) ?? null }
}

export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { ready, prefs, row } = await load(userId)
    return NextResponse.json(body(prefs, row, ready), { headers: noStore })
  } catch (e) {
    return serverError('[me/notification-preferences GET]', e)
  }
}

export async function PUT(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('PUT /me/notification-preferences')
  if (delegated) return delegated
  const rl = await enforce(limiters.notifyPrefs, `notify-prefs:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const parsed = notificationSettingsSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body', issues: parsed.error.flatten() }, { status: 422 })
  const input = parsed.data

  // The last row per (category, channel) wins; push has no delivery in V1, so it is not stored.
  const byKey = new Map<string, NotificationPreference>()
  for (const p of input.preferences) if ((PREFERENCE_CHANNELS as readonly string[]).includes(p.channel)) byKey.set(`${p.category}:${p.channel}`, p)
  const prefs = [...byKey.values()]
  const stranded = essentialCategoriesWithoutChannel(prefs)
  if (stranded.length > 0) return NextResponse.json({ error: 'essential_needs_channel', categories: stranded }, { status: 422 })

  let pausedUntil = input.pausedUntil
  if (pausedUntil) {
    const t = new Date(pausedUntil).getTime()
    if (t > Date.now() + NOTIFY_MAX_PAUSE_DAYS * 86_400_000) return NextResponse.json({ error: 'pause_too_long', maxDays: NOTIFY_MAX_PAUSE_DAYS }, { status: 422 })
    pausedUntil = t > Date.now() ? new Date(t).toISOString() : null
  }
  const quietHours = input.quietHours && input.quietHours.start !== input.quietHours.end ? input.quietHours : null
  const row = settingsRowFrom({ quietHours, pausedUntil, digestLeads: input.digestLeads })

  const admin = await createAdminClient()
  const nowIso = new Date().toISOString()
  // Only choices that differ from the category default are rows; the rest read as the default.
  const keep = prefs.filter((p) => p.enabled !== categoryDefault(p.category, p.channel))
  const keepKeys = new Set(keep.map((p) => `${p.category}:${p.channel}`))

  const settingsWrite = await admin.from('notification_settings').upsert({ user_id: userId, ...row, updated_at: nowIso }, { onConflict: 'user_id' })
  if (isMissingRelation(settingsWrite.error)) return NextResponse.json({ error: 'not_ready' }, { status: 503 })
  if (settingsWrite.error) return serverError('[me/notification-preferences PUT] settings', settingsWrite.error)

  if (keep.length > 0) {
    const { error } = await admin
      .from('notification_preferences')
      .upsert(keep.map((p) => ({ user_id: userId, category: p.category, channel: p.channel, enabled: p.enabled, updated_at: nowIso })), { onConflict: 'user_id,category,channel' })
    if (isMissingRelation(error)) return NextResponse.json({ error: 'not_ready' }, { status: 503 })
    if (error) return serverError('[me/notification-preferences PUT] preferences', error)
  }
  const { data: existing } = await admin.from('notification_preferences').select('category, channel').eq('user_id', userId)
  for (const r of (existing ?? []) as { category: string; channel: string }[]) {
    if (keepKeys.has(`${r.category}:${r.channel}`)) continue
    const { error } = await admin.from('notification_preferences').delete().eq('user_id', userId).eq('category', r.category).eq('channel', r.channel)
    if (error) return serverError('[me/notification-preferences PUT] reset', error)
  }

  const effective = effectivePreferences(keep)
  const offIn = (channel: string) => effective.filter((p) => p.channel === channel && !p.enabled && p.category !== 'updates').map((p) => p.category)
  captureServerEvent(userId, 'notification_prefs_changed', {
    whatsapp_off: offIn('whatsapp'),
    sms_off: offIn('sms'),
    email_off: offIn('email'),
    changed: keep.length,
    quiet_hours: !!quietHours,
    paused: !!pausedUntil,
    digest: input.digestLeads,
  })
  return NextResponse.json(body(keep, row, true), { headers: noStore })
}
