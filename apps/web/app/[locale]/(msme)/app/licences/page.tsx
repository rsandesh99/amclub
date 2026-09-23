import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { isObligationsOn, listMyLicences } from '@/lib/licences'
import { LicenceForm } from '@/components/licences-v3/LicenceForm'
import { LicenceList } from '@/components/licences-v3/LicenceList'

/** Experience v3 E9b (FR-9.5, F7) — "My licences" (dark behind obligations_enabled; the home otherwise). */
export default async function LicencesPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/licences')
  if (!(await isObligationsOn())) redirect('/app')
  const t = await getTranslations('licences_v3')
  const licences = await listMyLicences(await createClient())
  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6" data-testid="licences-page">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="t-large-title">{t('title')}</h1>
        <Link href="/app/obligations" className="t-footnote font-medium text-primary">{t('what_do_i_need')}</Link>
      </div>
      <p className="text-sm text-foreground-secondary">{t('subtitle')}</p>
      {licences.length > 0 ? <LicenceList licences={licences} /> : <p className="text-sm text-foreground-secondary">{t('empty')}</p>}
      <LicenceForm />
    </div>
  )
}
