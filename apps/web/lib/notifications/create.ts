import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import { CHANNELS, type ChannelMessage, type ChannelResult } from './channels'

type Admin = Awaited<ReturnType<typeof createAdminClient>>
// te is optional: templates carry it only where translated; resolveText falls
// back to en (never hi) for a te user with no te slot (S3.2).
type I18n = { en: string; hi: string; te?: string }
type Locale = 'en' | 'hi' | 'te'

/** Pick the user's locale text, en fallback for any missing slot. */
function resolveText(t: I18n, locale: Locale): string {
  return t[locale] ?? t.en
}

export interface NotificationInput {
  userId: string
  kind: string
  titleI18n: I18n
  bodyI18n: I18n
  link?: string
  /** Extra channels beyond in-app, e.g. 'email' | 'sms' | 'whatsapp'. */
  channels?: string[]
}

/**
 * `notification.dispatch` (§5.9). Always writes the in-app row, then fans the
 * same notification out across the requested channels via the CHANNELS registry.
 * Each channel runs independently with its own try/catch — one channel failing
 * (e.g. Resend down) never blocks the others or the triggering action. The
 * in-app insert is the source of truth for the notification centre + bell.
 * Never throws.
 */
export async function createNotification(admin: Admin, input: NotificationInput): Promise<void> {
  const extra = input.channels ?? []
  const channels = ['in_app', ...extra]
  try {
    await admin.from('notifications').insert({
      user_id: input.userId,
      kind: input.kind,
      title_i18n: input.titleI18n,
      body_i18n: input.bodyI18n,
      link: input.link ?? null,
      channels,
    })
  } catch (e) {
    console.error('[createNotification:in_app]', e)
  }
  if (extra.length > 0) await fanout(admin, [input.userId], input, extra)
}

/** Fan a notification out to many users (e.g. RFQ fan-out). Best-effort. */
export async function createNotificationsBulk(
  admin: Admin,
  userIds: string[],
  base: Omit<NotificationInput, 'userId'>,
): Promise<void> {
  if (userIds.length === 0) return
  const extra = base.channels ?? []
  const channels = ['in_app', ...extra]
  try {
    await admin.from('notifications').insert(
      userIds.map((userId) => ({
        user_id: userId,
        kind: base.kind,
        title_i18n: base.titleI18n,
        body_i18n: base.bodyI18n,
        link: base.link ?? null,
        channels,
      })),
    )
  } catch (e) {
    console.error('[createNotificationsBulk:in_app]', e)
  }
  if (extra.length > 0) await fanout(admin, userIds, base, extra)
}

/** Resolve recipients' contact + locale and run each extra channel handler. */
async function fanout(
  admin: Admin,
  userIds: string[],
  base: Omit<NotificationInput, 'userId'>,
  extra: string[],
): Promise<void> {
  const { data: users } = await admin
    .from('users')
    .select('id, email, phone, preferred_locale')
    .in('id', userIds)
  const byId = new Map((users ?? []).map((u) => [u.id, u]))
  // S0.5 — who has opted in to WhatsApp (an active whatsapp grant). One query per batch.
  const optIn = new Set<string>()
  if (extra.includes('whatsapp')) {
    const { data: grants } = await admin.from('agent_grants').select('user_id').in('user_id', userIds).eq('channel', 'whatsapp').is('revoked_at', null)
    for (const g of grants ?? []) optIn.add((g as { user_id: string }).user_id)
  }

  const tasks: Promise<ChannelResult>[] = []
  for (const userId of userIds) {
    const u = byId.get(userId)
    const pl = u?.preferred_locale
    const locale: Locale = pl === 'hi' || pl === 'te' ? pl : 'en'
    const msg: ChannelMessage = {
      toUserId: userId,
      whatsappOptIn: optIn.has(userId),
      email: u?.email ?? null,
      phone: u?.phone ?? null,
      locale,
      title: resolveText(base.titleI18n, locale),
      body: resolveText(base.bodyI18n, locale),
      link: base.link ?? null,
      kind: base.kind,
    }
    for (const ch of extra) {
      const handler = CHANNELS[ch]
      if (!handler) continue
      tasks.push(handler(msg).catch((e) => ({ channel: ch, ok: false, detail: `error:${(e as Error).message}` })))
    }
  }
  const results = await Promise.all(tasks)
  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) console.warn('[notify:fanout] channel failures', failed)
}
