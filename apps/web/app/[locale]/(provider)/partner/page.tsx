import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export default async function PartnerDashboardPage() {
  const t = await getTranslations('partner_home')
  const tProfile = await getTranslations('profile')
  const tCommon = await getTranslations('common')

  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner')

  const profile = await getProviderProfile(user.id)
  // No profile yet → send to onboarding wizard
  if (!profile) redirect('/partner/onboarding')

  const isUnderReview = profile.status !== 'active'
  const hasMsmeRole = user.roles.includes('msme')

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar */}
      <header className="border-b border-gray-200 bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-2xl items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-base font-bold text-primary">AMClub Partner</span>
            <Badge variant={isUnderReview ? 'warning' : 'success'}>
              {isUnderReview ? tCommon('na') : tCommon('verified')}
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            {hasMsmeRole && (
              <Link href="/app" className="text-xs text-primary underline underline-offset-2">
                {tProfile('switch_to_msme')}
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-6 space-y-6">
        {/* Under review banner */}
        {isUnderReview && (
          <div className="rounded-card border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm text-amber-800">{t('under_review_banner')}</p>
          </div>
        )}

        <div>
          <h1 className="text-xl font-semibold">{t('dashboard_title')}</h1>
          <p className="text-sm text-foreground-secondary">{profile.displayName}</p>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: t('new_rfqs'), value: '0' },
            { label: t('active_orders'), value: String(profile.completedOrders) },
            { label: t('earnings_month'), value: '₹0' },
          ].map((stat) => (
            <div key={stat.label} className="rounded-card border border-gray-200 bg-surface p-4 shadow-card text-center">
              <p className="text-2xl font-bold text-primary">{stat.value}</p>
              <p className="mt-1 text-xs text-foreground-secondary">{stat.label}</p>
            </div>
          ))}
        </div>

        {/* Quick links */}
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              { label: t('view_rfqs'), href: '/partner/rfqs', icon: '📬' },
              { label: t('view_orders'), href: '/partner/orders', icon: '📦' },
            ] as { label: string; href: string; icon: string }[]
          ).map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="flex flex-col items-center gap-2 rounded-card border border-gray-200 bg-surface p-4 text-center shadow-card hover:border-primary/40 transition-colors"
            >
              <span className="text-2xl">{link.icon}</span>
              <span className="text-sm font-medium">{link.label}</span>
            </Link>
          ))}
        </div>

        {/* Onboarding CTA if profile incomplete */}
        {isUnderReview && profile.status === 'pending_kyc' && (
          <div className="rounded-card border border-primary/30 bg-primary/5 p-4">
            <p className="text-sm font-medium text-primary">{t('onboarding_cta')}</p>
            <Link href="/partner/onboarding">
              <Button size="sm" className="mt-3">{t('complete_onboarding')}</Button>
            </Link>
          </div>
        )}
      </main>
    </div>
  )
}
