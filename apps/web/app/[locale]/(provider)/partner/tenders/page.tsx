import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { isTendersOn, listTenderAlerts } from '@/lib/partner-v3/tenders'
import { istDay } from '@/lib/dates'
import { TenderAlerts } from '@/components/partner-v3/TenderAlerts'

/**
 * E11 FR-11.6 (N30; D9, dark) — tender alerts for verified government-and-
 * licensing providers, and the reviewed GeM seller checklist. Alerts only.
 */
export default async function PartnerTendersPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/tenders')
  const admin = await createAdminClient()
  if (!(await isTendersOn(admin))) redirect('/partner')
  const profile = await getProviderProfile(user.id)
  if (!profile) redirect('/partner/onboarding')
  const [t, locale] = await Promise.all([getTranslations('partner_v3'), getLocale()])
  const alerts = await listTenderAlerts(admin, profile.id)
  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-6" data-testid="tenders-page">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="t-large-title">{t('tenders_title')}</h1>
        <Link href="/partner/tenders/gem-checklist" className="t-footnote font-medium text-primary">{t('gem_link')}</Link>
      </div>
      <p className="text-sm text-foreground-secondary">{t('tenders_intro')}</p>
      {alerts === 'not_eligible' ? (
        <p className="rounded-card border border-dashed border-border px-4 py-6 text-center text-sm text-foreground-secondary" data-testid="tenders-not-eligible">{t('tenders_not_eligible')}</p>
      ) : (
        <TenderAlerts
          alerts={alerts.map((a) => ({ ...a, closes: istDay(`${a.closesOn}T00:00:00+05:30`, locale), band: a.valueBand ? t(`band_${a.valueBand}` as 'band_under_5l') : '—' }))}
          labels={{ save: t('tender_save'), saved: t('tender_saved'), notRelevant: t('tender_not_relevant'), portal: t('tender_portal'), closes: t('tender_closes') }}
        />
      )}
    </div>
  )
}
