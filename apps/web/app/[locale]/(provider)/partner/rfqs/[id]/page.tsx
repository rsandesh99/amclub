import { redirect, notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { getRfqForProvider } from '@/lib/rfq/queries'
import { Badge } from '@/components/ui/badge'
import { QuoteComposer } from '@/components/rfq/QuoteComposer'
import { QuoteTermsRow } from '@/components/rfq/QuoteTermsRow'
import { formatINR } from '@/lib/format'

export default async function ProviderRfqPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=/partner/rfqs/${id}`)
  const profile = await getProviderProfile(user.id)
  if (!profile) redirect('/partner/onboarding')
  const t = await getTranslations('rfq')
  const rfq = await getRfqForProvider(user.id, id)
  if (!rfq) notFound()

  const details = Object.entries(rfq.details).filter(([, v]) => v != null && String(v).trim() !== '')

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 space-y-6">
      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <h1 className="font-display text-xl font-bold">{rfq.title}</h1>
          <Badge variant="info">{t('quotes_n', { n: rfq.quoteCount, max: rfq.maxQuotes })}</Badge>
        </div>
        {details.length > 0 && (
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-4 text-sm">
            {details.map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs capitalize text-foreground-secondary">{k.replace(/_/g, ' ')}</dt>
                <dd className="font-medium">{String(v)}</dd>
              </div>
            ))}
            {(rfq.budgetMinPaise || rfq.budgetMaxPaise) && (
              <div>
                <dt className="text-xs text-foreground-secondary">{t('budget')}</dt>
                <dd className="font-medium">{rfq.budgetMinPaise ? formatINR(rfq.budgetMinPaise) : '—'} – {rfq.budgetMaxPaise ? formatINR(rfq.budgetMaxPaise) : '—'}</dd>
              </div>
            )}
            {rfq.neededBy && (
              <div>
                <dt className="text-xs text-foreground-secondary">{t('needed_by')}</dt>
                <dd className="font-medium">{rfq.neededBy}</dd>
              </div>
            )}
          </dl>
        )}
      </div>

      {rfq.myQuote ? (
        <div className="rounded-card border border-success/40 bg-success/5 p-5">
          <p className="text-sm font-semibold text-success">{t('your_quote')}</p>
          <p className="mt-1 text-sm">{formatINR(rfq.myQuote.pricePaise)} · {t('delivery_days', { days: rfq.myQuote.deliveryDays })}</p>
          <p className="mt-2 whitespace-pre-wrap text-sm text-foreground-secondary">{rfq.myQuote.scope}</p>
          <div className="mt-3"><QuoteTermsRow terms={rfq.myQuote} compact /></div>
        </div>
      ) : rfq.canQuote ? (
        <QuoteComposer rfqId={rfq.id} />
      ) : (
        <div className="rounded-card border border-border bg-muted p-4 text-center text-sm text-foreground-secondary">
          {t('rfq_closed')}
        </div>
      )}
    </div>
  )
}
