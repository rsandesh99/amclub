'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { usePublicMe } from '@/components/catalog/usePublicMe'

/**
 * "Make a privacy request" on static public pages (the privacy policy, help):
 * a buyer goes to /app/privacy, a provider-only account to /partner/privacy
 * (the buyer group would send them to buyer sign-up), a visitor signs in first.
 */
export function PrivacyRequestLink({ className }: { className?: string }) {
  const t = useTranslations('privacy_requests')
  const me = usePublicMe()
  const href = me
    ? me.hasMsmeProfile === false && me.hasProviderProfile ? '/partner/privacy' : '/app/privacy'
    : '/login?next=/app/privacy'
  return (
    <Link href={href as '/app'} className={className ?? 'font-medium text-primary underline underline-offset-2 hover:no-underline'} data-testid="privacy-request-link">
      {t('link_from_policy')}
    </Link>
  )
}
