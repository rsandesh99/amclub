import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { getSessionUser } from '@/lib/auth/session'
import { isTendersOn, getReviewedPage } from '@/lib/partner-v3/tenders'
import { istDay } from '@/lib/dates'
import { GemChecklistViewed } from '@/components/partner-v3/GemChecklistViewed'

/** E11 FR-11.6 — the GeM seller checklist (CMS; shown only within 180 days of its last review). D9, dark. */
export default async function GemChecklistPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/tenders/gem-checklist')
  if (!(await isTendersOn())) redirect('/partner')
  const [t, locale] = await Promise.all([getTranslations('partner_v3'), getLocale()])
  const page = await getReviewedPage('gem-seller-checklist', locale)
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6" data-testid="gem-checklist">
      {page ? (
        <>
          <GemChecklistViewed />
          <h1 className="t-large-title">{page.title}</h1>
          <ul className="list-disc space-y-1.5 pl-5 text-sm">{page.items.map((i) => <li key={i}>{i}</li>)}</ul>
          <p className="t-caption text-foreground-secondary" data-testid="gem-reviewed">{t('ob_reviewed_short', { by: page.reviewedBy, date: istDay(page.reviewedAt, locale) })}</p>
        </>
      ) : (
        <p className="text-sm text-foreground-secondary" data-testid="gem-unavailable">{t('gem_unavailable')}</p>
      )}
    </div>
  )
}
