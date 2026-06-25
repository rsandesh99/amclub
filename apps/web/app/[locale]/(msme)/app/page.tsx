import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { getSessionUser, getMsmeProfile } from '@/lib/auth/session'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'

function getGreeting() {
  const hour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getHours()
  if (hour < 12) return 'greeting_morning'
  if (hour < 17) return 'greeting_afternoon'
  return 'greeting_evening'
}

export default async function MsmeHomePage() {
  const t = await getTranslations('msme_home')
  const tProfile = await getTranslations('profile')

  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getMsmeProfile(user.id)
  if (!profile) redirect('/signup?complete=1')

  const greeting = getGreeting()
  const name = user.fullName?.split(' ')[0] ?? 'there'
  const hasBothRoles = user.roles.includes('provider')

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar */}
      <header className="border-b border-gray-200 bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-lg items-center justify-between">
          <span className="text-base font-bold text-primary">AMClub</span>
          <div className="flex items-center gap-3">
            {hasBothRoles && (
              <Link href="/partner" className="text-xs text-primary underline underline-offset-2">
                {tProfile('switch_to_provider')}
              </Link>
            )}
            <Link href="/app/profile" className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
              {(user.fullName ?? '?').charAt(0).toUpperCase()}
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-lg px-4 py-6 space-y-6">
        {/* Greeting */}
        <div>
          <h1 className="text-xl font-semibold">
            {greeting === 'greeting_morning' ? t('greeting_morning') : greeting === 'greeting_afternoon' ? t('greeting_afternoon') : t('greeting_evening')}, {name} 👋
          </h1>
          <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
        </div>

        {/* Profile completeness */}
        {profile.profileCompleteness < 80 && (
          <div className="rounded-card border border-amber-200 bg-amber-50 p-4">
            <p className="mb-2 text-sm font-medium text-amber-800">{t('complete_profile_cta')}</p>
            <Progress value={profile.profileCompleteness} label={tProfile('completeness')} />
            <Link href="/app/profile" className="mt-3 inline-block text-xs text-primary underline underline-offset-2">
              {tProfile('edit_profile')} →
            </Link>
          </div>
        )}

        {/* Quick actions */}
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              { label: t('browse_services'), href: '/services', icon: '🔍' },
              { label: t('post_rfq'), href: '/app/rfq/new', icon: '📋' },
              { label: t('my_orders'), href: '/app/orders', icon: '📦' },
            ] as { label: string; href: string; icon: string }[]
          ).map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className="flex flex-col items-center justify-center gap-2 rounded-card border border-gray-200 bg-surface p-4 text-center shadow-card hover:border-primary/40 hover:bg-primary/5 transition-colors"
            >
              <span className="text-2xl">{action.icon}</span>
              <span className="text-sm font-medium">{action.label}</span>
            </Link>
          ))}
        </div>

        {/* Recent orders placeholder */}
        <div className="rounded-card border border-gray-200 bg-surface p-6 text-center shadow-card">
          <p className="text-sm font-medium">{t('no_orders_title')}</p>
          <p className="mt-1 text-xs text-foreground-secondary">{t('no_orders_subtitle')}</p>
          <Link href="/services">
            <Button variant="secondary" size="sm" className="mt-4">
              {t('explore_cta')}
            </Button>
          </Link>
        </div>
      </main>
    </div>
  )
}
