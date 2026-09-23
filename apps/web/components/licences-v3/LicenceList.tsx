import { getLocale, getTranslations } from 'next-intl/server'
import type { LicenceView } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { istDay } from '@/lib/dates'
import { RemoveLicenceButton } from './LicenceForm'

/** E9b — the buyer's licences, soonest expiry first; "Renew" routes to the category that provides it. */
export async function LicenceList({ licences, editable = true }: { licences: LicenceView[]; editable?: boolean }) {
  const t = await getTranslations('licences_v3')
  const locale = await getLocale()
  return (
    <ul className="divide-y divide-separator overflow-hidden rounded-card border border-border bg-surface" data-testid="licence-list">
      {licences.map((l) => {
        const due = l.daysLeft !== null && l.daysLeft <= 60
        return (
          <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3" data-licence={l.licenceType}>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t(`type_${l.licenceType}`)}{l.number ? <span className="ml-2 text-foreground-secondary tabular-nums">{l.number}</span> : null}</p>
              <p className={`t-footnote ${due ? 'text-warning' : 'text-foreground-secondary'}`}>
                {l.daysLeft === null
                  ? t('no_expiry')
                  : l.daysLeft < 0
                    ? t('expired', { days: -l.daysLeft })
                    : `${t('expires_on', { date: istDay(`${l.expiresOn}T00:00:00+05:30`, locale) })} · ${t('expires_in', { days: l.daysLeft })}`}
                {l.source === 'order' ? ` · ${t('source_order')}` : ''}
              </p>
            </div>
            {l.hasCertificate && <a href={`/api/v1/me/licences/${l.id}/certificate`} className="t-footnote text-primary underline-offset-2 hover:underline" target="_blank" rel="noopener noreferrer">{t('view_certificate')}</a>}
            {due && <Link href={l.renewHref as '/services'} className="t-footnote rounded-chip bg-primary px-3 py-1 font-medium text-primary-foreground">{t('renew')}</Link>}
            {editable && <RemoveLicenceButton id={l.id} />}
          </li>
        )
      })}
    </ul>
  )
}
