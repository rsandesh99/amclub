import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PRIVACY_REQUEST_DUE_DAYS } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { PrivacyRequests } from '@/components/settings/PrivacyRequests'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('privacy_requests')
  return { title: t('title') }
}

/** DPDP requests for providers (ADR-030 §6). Needs only a signed-in account, not an approved provider profile. */
export default async function ProviderPrivacyPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/privacy')
  const t = await getTranslations('privacy_requests')
  return (
    <div className="mx-auto max-w-2xl space-y-5 px-4 py-6" data-testid="privacy-page">
      <div>
        <Link href="/partner/profile" className="text-sm font-medium text-primary hover:underline">← {t('back_to_profile')}</Link>
        <h1 className="mt-2 text-xl font-semibold">{t('title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle', { days: PRIVACY_REQUEST_DUE_DAYS })}</p>
      </div>
      <PrivacyRequests persona="provider" />
      <p className="text-sm text-foreground-secondary">
        <Link href="/privacy" className="font-medium text-primary hover:underline">{t('policy_link')}</Link>
        {' · '}
        <Link href="/grievance" className="font-medium text-primary hover:underline">{t('grievance_link')}</Link>
      </p>
    </div>
  )
}
