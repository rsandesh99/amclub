'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { AccountMenu } from '@/components/shell/AccountMenu'
import { usePublicMe } from './usePublicMe'

/**
 * Client-side auth area for the (static) public header: shows the account menu
 * when logged in, Sign in / Sign up when not. Kept client-only so the public
 * marketing/catalog pages stay static/ISR (no cookie read on the server).
 */
export function PublicHeaderAccount() {
  const tAuth = useTranslations('auth')
  const me = usePublicMe()

  // Until we know: an empty slot the size of what will most likely appear, so
  // the header does not jump. The server HTML is the same for everyone (the
  // "Sign in · Sign up" footprint); the root layout's pre-paint script marks
  // <html data-auth> when a session cookie exists, and then the slot takes the
  // avatar button's footprint instead (44 px; 66 px with its chevron from sm).
  if (me === undefined) {
    return <div className="h-10 w-[5.25rem] sm:w-[10.5rem] [html[data-auth]_&]:w-11 sm:[html[data-auth]_&]:w-[4.125rem]" aria-hidden data-testid="account-slot" />
  }

  if (me) {
    const roles = me.roles ?? []
    return (
      <AccountMenu
        name={me.fullName ?? null}
        context="public"
        hasMsme={me.hasMsmeProfile ?? roles.includes('msme')}
        hasProvider={me.hasProviderProfile ?? roles.includes('provider')}
        isAdmin={roles.includes('admin') || roles.includes('ops')}
      />
    )
  }

  return (
    <div className="flex h-10 items-center gap-2">
      {/* Phones get one filled "Sign in" (the login page links to sign-up);
          tablet and up show both, outlined + filled, on the same 40px axis. */}
      <Link
        href="/login"
        className="inline-flex h-10 items-center whitespace-nowrap rounded-button border px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 border-primary bg-primary text-white hover:bg-primary-strong sm:border-primary/30 sm:bg-surface sm:text-primary sm:hover:border-primary sm:hover:bg-primary/5"
      >
        {tAuth('sign_in')}
      </Link>
      <Link
        href="/signup"
        className="hidden h-10 items-center whitespace-nowrap rounded-button bg-primary px-4 text-sm font-semibold text-white transition-colors hover:bg-primary-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 sm:inline-flex"
      >
        {tAuth('sign_up')}
      </Link>
    </div>
  )
}
