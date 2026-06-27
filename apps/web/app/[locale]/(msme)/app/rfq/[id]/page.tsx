import { redirect, notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSessionUser } from '@/lib/auth/session'
import { getRfqForBuyer } from '@/lib/rfq/queries'
import { Badge } from '@/components/ui/badge'
import { QuoteCompare } from '@/components/rfq/QuoteCompare'
import { formatINR } from '@/lib/format'

const VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  open: 'info', quoted: 'warning', accepted: 'success', expired: 'default', cancelled: 'default',
}

export default async function BuyerRfqPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=/app/rfq/${id}`)
  const t = await getTranslations('rfq')
  const rfq = await getRfqForBuyer(user.id, id)
  if (!rfq) notFound()

  const details = Object.entries(rfq.details).filter(([, v]) => v != null && String(v).trim() !== '')

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 space-y-6">
      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <h1 className="font-display text-xl font-bold">{rfq.title}</h1>
          <Badge variant={VARIANT[rfq.status] ?? 'default'}>{t(`status_${rfq.status}` as 'status_open')}</Badge>
        </div>

        {/* RFQ pending state copy (§3.8) */}
        {(rfq.status === 'open' || rfq.status === 'quoted') && (
          <p className="mt-2 text-xs text-foreground-secondary">{t('sent_to_providers', { n: rfq.quoteCount > 0 ? rfq.quoteCount : '—' })}</p>
        )}

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
                <dd className="font-medium">
                  {rfq.budgetMinPaise ? formatINR(rfq.budgetMinPaise) : '—'} – {rfq.budgetMaxPaise ? formatINR(rfq.budgetMaxPaise) : '—'}
                </dd>
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

      <QuoteCompare rfq={rfq} />
    </div>
  )
}
