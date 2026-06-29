'use client'

import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'

const ITEMS = [
  { href: '/admin/verifications', key: 'verifications' },
  { href: '/admin/reviews', key: 'reviews' },
  { href: '/admin/coupons', key: 'coupons' },
  { href: '/admin/cms', key: 'cms' },
] as const

/** Ops sub-navigation across the admin surfaces (A4/A6/§7). The Coupons tab is
 *  hidden while the COUPONS_ENABLED flag is OFF (passed from the layout). */
export function AdminNav({ couponsEnabled = false }: { couponsEnabled?: boolean }) {
  const t = useTranslations('admin_nav')
  const pathname = usePathname()
  const items = ITEMS.filter((it) => it.key !== 'coupons' || couponsEnabled)
  return (
    <nav className="flex flex-wrap gap-1 border-b border-border px-6 pt-4">
      {items.map((it) => {
        const active = pathname.includes(it.href)
        return (
          <Link
            key={it.href}
            href={it.href as '/admin/verifications'}
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
