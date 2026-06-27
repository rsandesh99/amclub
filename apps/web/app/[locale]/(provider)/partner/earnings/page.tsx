import { redirect } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { listMyOrders, listMyPayouts } from '@/lib/orders/queries'
import { Badge } from '@/components/ui/badge'
import { formatINR } from '@/lib/format'

const ACTIVE_STATUSES = ['placed', 'accepted', 'requirements_submitted', 'in_progress', 'delivered', 'revision_requested']

type BadgeMeta = { key: string; variant: 'success' | 'warning' | 'danger' | 'default' }
const PAYOUT_BADGE: Record<string, BadgeMeta> = {
  paid: { key: 'payout_paid', variant: 'success' },
  processing: { key: 'payout_processing', variant: 'default' },
  scheduled: { key: 'payout_scheduled', variant: 'default' },
  failed: { key: 'payout_failed', variant: 'danger' },
  held: { key: 'payout_held', variant: 'warning' },
}
const DEFAULT_BADGE: BadgeMeta = { key: 'payout_scheduled', variant: 'default' }

export default async function PartnerEarningsPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/earnings')
  const profile = await getProviderProfile(user.id)
  if (!profile) redirect('/partner/onboarding')

  const t = await getTranslations('earnings')
  const locale = await getLocale()
  const [orders, payouts] = await Promise.all([
    listMyOrders(user.id, 'provider'),
    listMyPayouts(user.id),
  ])

  const completed = orders.filter((o) => o.status === 'completed')
  const lifetimePaise = completed.reduce((s, o) => s + Number(o.provider_earning_paise), 0)
  const inProgressPaise = orders
    .filter((o) => ACTIVE_STATUSES.includes(o.status))
    .reduce((s, o) => s + Number(o.provider_earning_paise), 0)

  const dateFmt = new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  })

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: t('lifetime_earnings'), value: formatINR(lifetimePaise) },
          { label: t('completed_orders'), value: String(completed.length) },
          { label: t('pending_clearance'), value: formatINR(inProgressPaise) },
        ].map((s) => (
          <div key={s.label} className="rounded-card border border-border bg-surface p-4 text-center shadow-card">
            <p className="font-display text-lg font-bold text-primary">{s.value}</p>
            <p className="mt-1 text-xs text-foreground-secondary">{s.label}</p>
          </div>
        ))}
      </div>

      <p className="rounded-button bg-primary/5 px-3 py-2 text-xs text-foreground-secondary">{t('payout_note')}</p>

      <section>
        <h2 className="mb-3 text-sm font-semibold">{t('payouts_title')}</h2>
        {payouts.length === 0 ? (
          <div className="rounded-card border border-dashed border-border bg-surface px-6 py-12 text-center">
            <p className="text-sm font-medium">{t('no_payouts_title')}</p>
            <p className="mt-1 text-xs text-foreground-secondary">{t('no_payouts_subtitle')}</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {payouts.map((p) => {
              const badge = PAYOUT_BADGE[p.status] ?? DEFAULT_BADGE
              const when = p.paidAt ?? p.scheduledFor
              return (
                <li key={p.id}>
                  <Link
                    href={`/partner/orders/${p.orderId}`}
                    className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface p-3 shadow-card hover:border-primary/40"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{p.orderTitle ?? p.orderNumber ?? '—'}</p>
                      <p className="text-xs text-foreground-secondary">
                        {formatINR(p.amountPaise)}
                        {when ? ` · ${dateFmt.format(new Date(when))}` : ''}
                      </p>
                    </div>
                    <Badge variant={badge.variant}>{t(badge.key as 'payout_paid')}</Badge>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
