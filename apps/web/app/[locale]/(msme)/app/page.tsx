import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { getSessionUser, getMsmeProfile } from '@/lib/auth/session'
import { listMyOrders } from '@/lib/orders/queries'
import { BannerSlot } from '@/components/cms/BannerSlot'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatINR } from '@/lib/format'
import { MART_ENABLED } from '@/lib/flags'
import { AGENT_ENABLED } from '@/lib/flags'
import { isSupportEnabledFor } from '@/lib/support/settings'
import { isProcurementEnabledFor } from '@/lib/agent/procurement'
import { createAdminClient } from '@/lib/supabase/server'
import { isOnFor } from '@/lib/experiments'
import { RecentlyViewed } from '@/components/recent-v3/RecentlyViewed'
import { HomeV3 } from '@/components/home-v3/HomeV3'
import { WhatsAppOptInCard } from '@/components/settings/WhatsAppOptInCard'

function getGreeting(): 'greeting_morning' | 'greeting_afternoon' | 'greeting_evening' {
  const hour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getHours()
  if (hour < 12) return 'greeting_morning'
  if (hour < 17) return 'greeting_afternoon'
  return 'greeting_evening'
}

export default async function MsmeHomePage() {
  const t = await getTranslations('msme_home')
  const tShell = await getTranslations('shell')
  const tProfile = await getTranslations('profile')
  const tOrders = await getTranslations('orders')

  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getMsmeProfile(user.id)
  if (!profile) redirect('/signup?complete=1')

  // S2.3 — the Help chat for an enabled, cohorted buyer (the page 404s for everyone else).
  const supportOn = AGENT_ENABLED ? await isSupportEnabledFor(await createAdminClient(), user.id) : false
  // S3.1 — the buying assistant for an enabled, cohorted buyer (the page 404s for everyone else).
  const assistantOn = AGENT_ENABLED ? await isProcurementEnabledFor(await createAdminClient(), user.id) : false
  const greeting = getGreeting()
  // Experience v3 E9 (flag `home`): the home as a tool.
  if (isOnFor('home', user.id)) {
    return (
      <HomeV3
        userId={user.id}
        firstName={user.fullName?.split(' ')[0] ?? ''}
        greetingKey={greeting}
        completeness={profile.profileCompleteness}
        supportOn={supportOn}
        assistantOn={assistantOn}
      />
    )
  }
  const orders = (await listMyOrders(user.id, 'msme')).slice(0, 3)
  const name = user.fullName?.split(' ')[0] ?? 'there'

  return (
    <div className="mx-auto max-w-lg px-4 py-6 space-y-6">
      {/* Greeting */}
      <div>
        <h1 className="text-xl font-semibold">
          {greeting === 'greeting_morning' ? t('greeting_morning') : greeting === 'greeting_afternoon' ? t('greeting_afternoon') : t('greeting_evening')}, {name} 👋
        </h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
      </div>

      {/* PRD_WHATSAPP W1 — one-time "Get order updates on WhatsApp" for accounts that never chose. */}
      <WhatsAppOptInCard persona="buyer" />

      {/* CMS hero slot (campaigns/announcements) — same banners as mobile home. */}
      <BannerSlot slot="hero" className="space-y-3 [&_.mx-auto]:px-0 [&_.mx-auto]:py-0" />

      {/* Profile completeness */}
      {profile.profileCompleteness < 80 && (
        <div className="rounded-card border border-warning/30 bg-warning/10 p-4">
          <p className="mb-2 text-sm font-medium text-warning">{t('complete_profile_cta')}</p>
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
            // E0 / U6 — the logged-in search (was /services, leaving /app/search unreachable).
            { label: t('browse_services'), href: '/app/search', icon: '🔍' },
            // AMC Mart (dark build): the tile exists only while MART_ENABLED.
            ...(MART_ENABLED ? [{ label: t('mart'), href: '/mart', icon: '🧰' }, { label: t('my_pools'), href: '/app/mart/pools', icon: '🤝' }] : []),
            { label: t('post_rfq'), href: '/app/rfq/new', icon: '📋' },
            { label: t('my_rfqs'), href: '/app/rfq', icon: '📨' },
            { label: t('my_orders'), href: '/app/orders', icon: '📦' },
            { label: t('saved'), href: '/app/saved', icon: '❤️' },
            // S2.3 — the Help chat for an enabled, cohorted buyer (the page 404s for everyone else).
            ...(supportOn ? [{ label: tShell('help_entry'), href: '/app/support', icon: '💬' }] : []),
            ...(assistantOn ? [{ label: tShell('assistant_entry'), href: '/app/assistant', icon: '🧑‍💼' }] : []),
          ] as { label: string; href: string; icon: string }[]
        ).map((action) => (
          <Link
            key={action.href}
            href={action.href}
            className="flex flex-col items-center justify-center gap-2 rounded-card border border-border bg-surface p-4 text-center shadow-card hover:border-primary/40 hover:bg-primary/5 transition-colors"
          >
            <span className="text-2xl">{action.icon}</span>
            <span className="text-sm font-medium">{action.label}</span>
          </Link>
        ))}
      </div>

      {/* Experience v3 E2b (N8, flag `search`): recently viewed providers and packages. */}
      {isOnFor('search', user.id) && <RecentlyViewed />}

      {/* Recent orders (real) */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('recent_orders')}</h2>
          {orders.length > 0 && (
            <Link href="/app/orders" className="text-xs text-primary hover:underline">{t('view_all')}</Link>
          )}
        </div>
        {orders.length === 0 ? (
          <div className="rounded-card border border-border bg-surface p-6 text-center shadow-card">
            <p className="text-sm font-medium">{t('no_orders_title')}</p>
            <p className="mt-1 text-xs text-foreground-secondary">{t('no_orders_subtitle')}</p>
            <Link href="/services">
              <Button variant="secondary" className="mt-4">{t('explore_cta')}</Button>
            </Link>
          </div>
        ) : (
          <ul className="space-y-2">
            {orders.map((o) => (
              <li key={o.id}>
                <Link href={`/app/orders/${o.id}`} className="flex items-center justify-between rounded-card border border-border bg-surface p-3 shadow-card hover:border-primary/40">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{o.title}</p>
                    <p className="text-xs text-foreground-secondary">{formatINR(Number(o.total_paise))}</p>
                  </div>
                  <Badge>{tOrders(`status_${o.status}` as 'status_placed')}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
