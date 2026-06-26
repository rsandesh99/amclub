import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { ComingSoon } from '@/components/shell/ComingSoon'

export default async function PartnerRfqsPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/rfqs')
  const profile = await getProviderProfile(user.id)
  if (!profile) redirect('/partner/onboarding')
  const t = await getTranslations('coming_soon')
  return <ComingSoon title={t('rfq_inbox_title')} body={t('rfq_inbox_body')} homeHref="/partner" />
}
