'use client'

import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'

const ITEMS = [
  { href: '/admin', key: 'dashboard' },
  { href: '/admin/providers', key: 'providers' },
  { href: '/admin/msmes', key: 'msmes' },
  { href: '/admin/orders', key: 'orders' },
  { href: '/admin/payouts', key: 'payouts' },
  { href: '/admin/disputes', key: 'disputes' },
  { href: '/admin/verifications', key: 'verifications' },
  { href: '/admin/categories', key: 'categories' },
  { href: '/admin/reviews', key: 'reviews' },
  { href: '/admin/coupons', key: 'coupons' },
  { href: '/admin/mart', key: 'mart' },
  { href: '/admin/agents', key: 'agents' },
  { href: '/admin/shadow', key: 'shadow' },
  // ADR-030 §6 — the WhatsApp ops console and DPDP requests / retention
  { href: '/admin/whatsapp', key: 'whatsapp' },
  { href: '/admin/privacy', key: 'privacy' },
  { href: '/admin/cms', key: 'cms' },
  { href: '/admin/audit', key: 'audit' },
] as const

/** Ops sub-navigation across the admin surfaces (§7 / A1-A6). The Coupons tab is
 *  hidden while COUPONS_ENABLED is OFF, the Mart tab while MART_ENABLED is OFF,
 *  and the Agents tab while AGENT_ENABLED is OFF (all passed from the layout). */
export function AdminNav({ couponsEnabled = false, martEnabled = false, agentEnabled = false }: { couponsEnabled?: boolean; martEnabled?: boolean; agentEnabled?: boolean }) {
  const t = useTranslations('admin_nav')
  const pathname = usePathname()
  const items = ITEMS.filter((it) => (it.key !== 'coupons' || couponsEnabled) && (it.key !== 'mart' || martEnabled) && (it.key !== 'agents' || agentEnabled))
  return (
    <nav className="flex flex-wrap gap-1 border-b border-border px-6 pt-4">
      {items.map((it) => {
        // '/admin' (dashboard) must match exactly, not as a prefix of every page.
        const active = it.href === '/admin' ? /\/admin\/?$/.test(pathname) : pathname.includes(it.href)
        return (
          <Link
            key={it.href}
            href={it.href as '/admin/verifications'}
            // Seventeen dynamic admin pages: no burst of RSC prefetches on every admin load (F10).
            prefetch={false}
            className={`rounded-t-button px-3 py-2 text-sm font-medium ${
              active ? 'border-b-2 border-primary text-primary' : 'text-foreground-secondary hover:text-foreground'
            }`}
          >
            {t(it.key)}
          </Link>
        )
      })}
    </nav>
  )
}
