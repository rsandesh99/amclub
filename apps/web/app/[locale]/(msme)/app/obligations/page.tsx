import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { indianStateName } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { getMyObligations, isObligationsOn } from '@/lib/licences'
import { istDay } from '@/lib/dates'
import { ChecklistViewed } from '@/components/licences-v3/ChecklistViewed'

/**
 * Experience v3 E9b (FR-9.5 "What do I need?") — a routing checklist, not
 * advice. The business facts are shown back for confirmation; each row is a
 * CA-reviewed rule with its source and review stamp and links to the category
 * that provides it. No model. Dark behind obligations_enabled.
 */
export default async function ObligationsPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/obligations')
  if (!(await isObligationsOn())) redirect('/app')
  const t = await getTranslations('licences_v3')
  const locale = await getLocale()
  const view = await getMyObligations(await createClient(), user.id)
  if (!view) redirect('/signup?complete=1')
  const stateName = indianStateName(view.facts.state, locale)
  const unknown = t('ob_unknown')
  // Each fact under its own label, in words (never the stored enum, never a bare "not set" of unknown meaning).
  const facts: [string, string][] = [
    [t('ob_fact_activity'), view.facts.activity ? t(`activity_${view.facts.activity}` as 'activity_services') : unknown],
    [t('ob_fact_state'), stateName ?? unknown],
    [t('ob_fact_size'), view.facts.sizeBand ? view.facts.sizeBand.replace('-', '–') : unknown],
  ]
  return (
    <div className="mx-auto max-w-2xl space-y-5 px-4 py-6" data-testid="obligations-page" data-rules={view.rules.map((r) => r.licenceType).join(',')}>
      <ChecklistViewed rules={view.rules.length} />
      <h1 className="t-large-title">{t('ob_title')}</h1>
      <div className="flex flex-wrap items-start justify-between gap-2 rounded-card border border-border bg-surface p-4" data-testid="obligations-facts">
        <div className="min-w-0">
          <p className="t-footnote font-medium text-foreground-secondary">{t('ob_facts_title')}</p>
          <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-sm">
            {facts.map(([label, value]) => (
              <div key={label} className="flex gap-1.5">
                <dt className="text-foreground-secondary">{label}</dt>
                <dd className="font-medium text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <Link href="/app/profile" className="t-footnote font-medium text-primary">{t('ob_edit')}</Link>
      </div>
      {view.rules.length === 0 ? (
        <p className="text-sm text-foreground-secondary">{t('ob_empty')}</p>
      ) : (
        <>
          <p className="text-sm">{t('ob_intro', { state: stateName ?? unknown })}</p>
          <ul className="divide-y divide-separator overflow-hidden rounded-card border border-border bg-surface">
            {view.rules.map((r) => (
              <li key={r.id} className="space-y-1 px-4 py-3" data-rule={r.licenceType}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{t(`type_${r.licenceType}`)}</p>
                  {r.held ? (
                    <span className="t-footnote font-medium text-success">{t('ob_held')}</span>
                  ) : (
                    <Link href={`/services/${r.categorySlug}` as '/services'} className="t-footnote font-medium text-primary">{t('ob_find')}</Link>
                  )}
                </div>
                <p className="t-caption text-foreground-secondary">
                  <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">{t('ob_source')}</a>
                  {' · '}
                  {t('ob_reviewed', { by: r.reviewedBy, date: istDay(r.reviewedAt, locale) })}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="t-footnote text-foreground-secondary" data-testid="obligations-disclaimer">{t('ob_disclaimer')}</p>
    </div>
  )
}
