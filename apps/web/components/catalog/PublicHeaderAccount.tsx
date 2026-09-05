'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { ProfileMeResponse } from '@amclub/shared'
import { AccountMenu } from '@/components/shell/AccountMenu'

// S2.3 — shared contract; Partial because the 401 body is {authenticated:false}.
type Me = Partial<ProfileMeResponse> & { authenticated: boolean }

/**
 * Client-side auth area for the (static) public header: shows the account menu
 * when logged in, Sign in / Sign up when not. Kept client-only so the public
 * marketing/catalog pages stay static/ISR (no cookie read on the server).
 */
export function PublicHeaderAccount() {
  const tAuth = useTranslations('auth')
  const [me, setMe] = useState<Me | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let active = true
    fetch('/api/v1/profile/me', { cache: 'no-store' })
      // Always drain the body — an unread (401) response keeps the request
      // "in flight" in Chromium, so the page never reaches network-idle.
      .then(async (r) => {
        const d = (await r.json().catch(() => null)) as Me | null
        return r.ok ? d : null
      })
      .then((d: Me | null) => {
        if (!active) return
        setMe(d?.authenticated ? d : null)
        setLoaded(true)
      })
      .catch(() => active && setLoaded(true))
    return () => { active = false }
  }, [])

  // Avoid a flash of the wrong state before we know.
  if (!loaded) return <div className="h-8 w-16" aria-hidden />

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
    <div className="flex items-center gap-2">
      <Link href="/login" className="rounded-button px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/5">
        {tAuth('sign_in')}
      </Link>
      <Link href="/signup" className="rounded-button bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary/90">
        {tAuth('sign_up')}
      </Link>
    </div>
  )
}
