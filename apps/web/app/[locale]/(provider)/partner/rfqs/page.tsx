import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Inbox } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { listMatchedRfqsForProvider } from '@/lib/rfq/queries'
import { Badge } from '@/components/ui/badge'

export default async function PartnerRfqsPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/rfqs')
  const profile = await getProviderProfile(user.id)
  if (!profile) redirect('/partner/onboarding')
  const t = await getTranslations('rfq')
  const rfqs = await listMatchedRfqsForProvider(user.id)

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="font-display text-2xl font-bold">{t('inbox_title')}</h1>
      <p className="mt-1 text-sm text-foreground-secondary">{t('inbox_subtitle')}</p>

      {rfqs.length === 0 ? (
        <div className="mt-6 flex flex-col items-center gap-3 rounded-card border border-dashed border-border bg-surface px-6 py-16 text-center">
          <Inbox className="h-10 w-10 text-foreground-secondary" />
          <p className="text-sm font-medium">{t('no_matched_title')}</p>
          <p className="text-sm text-foreground-secondary">{t('no_matched_body')}</p>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {rfqs.map((r) => (
            <li key={r.rfqId}>
              <Link href={`/partner/rfqs/${r.rfqId}`} className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 shadow-card hover:border-primary/40">
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.title}</p>
                  <p className="text-xs text-foreground-secondary">{t('quotes_n', { n: r.quoteCount, max: r.maxQuotes })}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {r.quoted ? <Badge variant="success">{t('quoted_badge')}</Badge> : !r.viewed ? <Badge variant="info">{t('new_label')}</Badge> : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
