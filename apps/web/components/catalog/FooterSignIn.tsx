'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { usePublicMe } from './usePublicMe'

/**
 * The footer's "Sign in", only for people who are not signed in. The footer is
 * static, so the answer comes from the same /profile/me read as the header
 * (one request). Until it arrives the link is hidden when the root layout's
 * pre-paint hint says a session cookie exists (<html data-auth>).
 */
export function FooterSignIn() {
  const t = useTranslations('auth')
  const me = usePublicMe()
  if (me) return null
  return (
    <li className={me === undefined ? '[html[data-auth]_&]:hidden' : undefined}>
      <Link href="/login" className="hover:text-primary">
        {t('sign_in')}
      </Link>
    </li>
  )
}
