import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>
type I18n = { en: string; hi: string }

export interface NotificationInput {
  userId: string
  kind: string
  titleI18n: I18n
  bodyI18n: I18n
  link?: string
  /** Extra channels beyond in-app, e.g. 'sms' | 'whatsapp'. Dispatched behind stubs. */
  channels?: string[]
}

/**
 * Create an in-app notification (always) and best-effort fan out to other
 * channels. The SMS/WhatsApp dispatchers are stubs until the Phase-6
 * `notification.dispatch` worker lands — they log and no-op so a missing
 * provider key never breaks the triggering action. Never throws.
 */
export async function createNotification(admin: Admin, input: NotificationInput): Promise<void> {
  const channels = ['in_app', ...(input.channels ?? [])]
  try {
    await admin.from('notifications').insert({
      user_id: input.userId,
      kind: input.kind,
      title_i18n: input.titleI18n,
      body_i18n: input.bodyI18n,
      link: input.link ?? null,
      channels,
    })
    for (const ch of input.channels ?? []) {
      // Phase 6 will replace these with MSG91 / Gupshup dispatch + retry.
      console.warn(`[notify:${ch} stub] user=${input.userId} kind=${input.kind}`)
    }
  } catch (e) {
    console.error('[createNotification]', e)
  }
}

/** Fan a notification out to many users (e.g. RFQ fan-out). Best-effort. */
export async function createNotificationsBulk(
  admin: Admin,
  userIds: string[],
  base: Omit<NotificationInput, 'userId'>,
): Promise<void> {
  if (userIds.length === 0) return
  const channels = ['in_app', ...(base.channels ?? [])]
  const rows = userIds.map((userId) => ({
    user_id: userId,
    kind: base.kind,
    title_i18n: base.titleI18n,
    body_i18n: base.bodyI18n,
    link: base.link ?? null,
    channels,
  }))
  try {
    await admin.from('notifications').insert(rows)
    if ((base.channels ?? []).length > 0) {
      console.warn(`[notify:${(base.channels ?? []).join(',')} stub] ${userIds.length} recipients kind=${base.kind}`)
    }
  } catch (e) {
    console.error('[createNotificationsBulk]', e)
  }
}
