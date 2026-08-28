import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { getProviderReadiness } from '@/lib/payments/readiness-server'
import { listMyOrders } from '@/lib/orders/queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatINR } from '@/lib/format'

const ACTIVE_STATUSES = ['placed', 'accepted', 'requirements_submitted', 'in_progress', 'delivered', 'revision_requested']

export default async function PartnerDashboardPage() {
  const t = await getTranslations('partner_home')

  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner')

  const profile = await getProviderProfile(user.id)
  if (!profile) redirect('/partner/onboarding')

  const isUnderReview = profile.status !== 'active'
  // Phase 3b (ii): an active provider whose payouts would hold sees why, here
  // and on /partner/earnings, until our team finishes the Route/bank link.
  const { readiness } = profile.status === 'active'
    ? await getProviderReadiness(await createAdminClient(), profile.id)
    : { readiness: 'ready' as const }
  const orders = await listMyOrders(user.id, 'provider')
  const activeCount = orders.filter((o) => ACTIVE_STATUSES.includes(o.status)).length
  const completedCount = orders.filter((o) => o.status === 'completed').length
  const earningsPaise = orders
    .filter((o) => o.status === 'completed')
    .reduce((sum, o) => sum + Number(o.provider_earning_paise), 0)

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 space-y-6">
      {isUnderReview && (
        <div className="rounded-card border border-warning/30 bg-warning/10 p-4">
          <p className="text-sm text-warning">{t('under_review_banner')}</p>
        </div>
      )}
      {!isUnderReview && readiness !== 'ready' && (
        <div className="rounded-card border border-warning/30 bg-warning/10 p-4">
          <p className="text-sm font-medium text-warning">{t('payout_hold_title')}</p>
          <p className="mt-1 text-sm text-foreground-secondary">{t('payout_hold_body')}</p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t('dashboard_title')}</h1>
          <p className="text-sm text-foreground-secondary">{profile.displayName}</p>
        </div>
        <Badge variant={isUnderReview ? 'warning' : 'success'}>
          {isUnderReview ? t('status_under_review') : t('status_active')}
        </Badge>
      </div>

      {/* Stats (real) */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: t('active_orders'), value: String(activeCount) },
          { label: t('completed_orders'), value: String(completedCount) },
          { label: t('earnings'), value: formatINR(earningsPaise) },
        ].map((stat) => (
          <div key={stat.label} className="rounded-card border border-border bg-surface p-4 shadow-card text-center">
            <p className="font-display text-xl font-bold text-primary">{stat.value}</p>
            <p className="mt-1 text-xs text-foreground-secondary">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Onboarding CTA */}
      {isUnderReview && profile.status === 'pending_kyc' && (
        <div className="rounded-card border border-primary/30 bg-primary/5 p-4">
          <p className="text-sm font-medium text-primary">{t('onboarding_cta')}</p>
          <Link href="/partner/onboarding">
            <Button className="mt-3">{t('complete_onboarding')}</Button>
          </Link>
        </div>
      )}

      {/* Quick links */}
      <div className="grid grid-cols-2 gap-3">
        {(
          [
            { label: t('manage_listings'), href: '/partner/listings', icon: '🗂️' },
            { label: t('view_orders'), href: '/partner/orders', icon: '📦' },
            { label: t('earnings'), href: '/partner/earnings', icon: '💰' },
            { label: t('view_rfqs'), href: '/partner/rfqs', icon: '📬' },
            { label: t('view_reviews'), href: '/partner/reviews', icon: '⭐' },
          ] as { label: string; href: string; icon: string }[]
        ).map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="flex flex-col items-center gap-2 rounded-card border border-border bg-surface p-4 text-center shadow-card hover:border-primary/40 transition-colors"
          >
            <span className="text-2xl">{link.icon}</span>
            <span className="text-sm font-medium">{link.label}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
