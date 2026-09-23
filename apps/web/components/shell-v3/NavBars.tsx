'use client'

import { useTranslations } from 'next-intl'
import { Link, usePathname } from '@/i18n/navigation'
import { cn } from '@/lib/utils'
import { CountBadge } from '@/components/ui-v3/Feedback'
import { useAnalytics } from '@/components/providers/posthog'
import { useMeActions } from './ActionsProvider'
import { buyerNav, isActive, providerNav, type NavItem } from './nav-items'

function useItems(role: 'buyer' | 'provider', martEnabled: boolean): NavItem[] {
  return role === 'buyer' ? buyerNav(martEnabled) : providerNav()
}

/** v3 SideRail (desktop ≥ lg): every item, badges from N2, current page marked. */
export function SideRail({ role, martEnabled = false }: { role: 'buyer' | 'provider'; martEnabled?: boolean }) {
  const t = useTranslations('nav_v3')
  const pathname = usePathname()
  const { actions } = useMeActions()
  const analytics = useAnalytics()
  const items = useItems(role, martEnabled)
  return (
    <nav aria-label={t('aria_main')} className="hidden w-56 shrink-0 lg:block">
      <ul className="sticky top-16 flex flex-col gap-0.5 py-4 pr-3">
        {items.map((it) => {
          const active = isActive(pathname, it)
          const n = actions && it.badge ? it.badge(actions) : 0
          const Icon = it.icon
          return (
            <li key={it.href}>
              <Link
                href={it.href as '/app'}
                aria-current={active ? 'page' : undefined}
                onClick={() => analytics.capture('nav_item_clicked', { item: it.labelKey, surface: 'rail', role })}
                className={cn(
                  'flex h-10 items-center gap-3 rounded-button px-3 text-[14px] font-medium transition-colors',
                  active ? 'bg-primary/10 text-primary' : 'text-foreground-secondary hover:bg-foreground/5 hover:text-foreground',
                )}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={active ? 2 : 1.5} aria-hidden />
                <span className="flex-1 truncate">{t(it.labelKey)}</span>
                <CountBadge count={n} label={t('badge_label', { count: n })} />
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/** v3 TabBar (phones and tablets < lg): 5 tabs on material, safe-area aware. */
export function TabBar({ role, martEnabled = false }: { role: 'buyer' | 'provider'; martEnabled?: boolean }) {
  const t = useTranslations('nav_v3')
  const pathname = usePathname()
  const { actions } = useMeActions()
  const analytics = useAnalytics()
  const items = useItems(role, martEnabled).filter((i) => !i.railOnly).slice(0, 5)
  return (
    <nav
      aria-label={t('aria_main')}
      className="material hairline-t fixed inset-x-0 bottom-0 z-30 lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="mx-auto grid max-w-xl grid-cols-5">
        {items.map((it) => {
          const active = isActive(pathname, it)
          const n = actions && it.badge ? it.badge(actions) : 0
          const Icon = it.icon
          return (
            <li key={it.href}>
              <Link
                href={it.href as '/app'}
                aria-current={active ? 'page' : undefined}
                onClick={() => analytics.capture('nav_item_clicked', { item: it.labelKey, surface: 'tabbar', role })}
                className={cn('relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium', active ? 'text-primary' : 'text-foreground-secondary')}
              >
                <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 2 : 1.5} aria-hidden />
                <span className="max-w-full truncate px-1">{t(it.labelKey)}</span>
                {n > 0 && <CountBadge count={n} label={t('badge_label', { count: n })} className="absolute right-[18%] top-1.5 h-4 min-w-4 px-1 text-[10px]" />}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
