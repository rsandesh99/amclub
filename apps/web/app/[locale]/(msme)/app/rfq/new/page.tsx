import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSessionUser } from '@/lib/auth/session'
import { ComingSoon } from '@/components/shell/ComingSoon'

export default async function NewRfqPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/rfq/new')
  const t = await getTranslations('coming_soon')
  return <ComingSoon title={t('rfq_title')} body={t('rfq_body')} homeHref="/app" showBrowse />
}
