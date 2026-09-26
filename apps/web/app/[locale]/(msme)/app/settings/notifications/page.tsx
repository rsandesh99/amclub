import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { NotificationSettingsForm } from '@/components/settings/NotificationSettingsForm'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('notification_settings')
  return { title: t('title') }
}

/** Settings → Notifications for buyers (PRD_WHATSAPP W1). The form reads and writes /api/v1/me/notification-preferences. */
export default async function BuyerNotificationSettingsPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/settings/notifications')
  const t = await getTranslations('notification_settings')
  return (
    <div className="mx-auto max-w-2xl space-y-5 px-4 py-6" data-testid="notification-settings-page">
      <div>
        <Link href="/app/profile" className="text-sm font-medium text-primary hover:underline">← {t('back_to_profile')}</Link>
        <h1 className="mt-2 text-xl font-semibold">{t('title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
      </div>
      <NotificationSettingsForm persona="buyer" whatsappHref="/app/profile#whatsapp" />
    </div>
  )
}
