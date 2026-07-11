'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'

/**
 * Compact legal/nav footer for the gateway reveal screens. The gateway paints
 * its own full-viewport island, so `(gateway)/layout.tsx` carries no
 * PublicFooter — the terminal reveal screens must surface the same required
 * links themselves. Mirrors PublicFooter's link set (browse, become-provider,
 * help, terms, privacy, refund). Client component: it lives inside the
 * client-only reveal tree, so it can't reuse the async server PublicFooter.
 */
export function RevealFooter() {
  const t = useTranslations()
  const links: { href: string; label: string }[] = [
    { href: '/services', label: t('catalog.browse_services') },
    { href: '/partner/onboarding', label: t('catalog.become_provider') },
    { href: '/help', label: t('legal.help_link') },
    { href: '/terms', label: t('legal.terms_title') },
    { href: '/privacy', label: t('legal.privacy_title') },
    { href: '/refund-policy', label: t('legal.refund_title') },
  ]

  return (
    <footer className="mt-auto border-t border-border bg-surface">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-6 sm:px-10">
        <nav className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] font-medium text-foreground-secondary">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="transition-colors hover:text-primary">
              {l.label}
            </Link>
          ))}
        </nav>
        <p className="text-xs text-foreground-secondary">
          © {new Date().getFullYear()} AMClub · {t('common.tagline')}
        </p>
      </div>
    </footer>
  )
}
