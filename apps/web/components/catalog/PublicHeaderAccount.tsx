'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { AccountMenu } from '@/components/shell/AccountMenu'

interface Me {
  authenticated: boolean
  fullName: string | null
  roles: string[]
}

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
    fetch('/api/v1/profile/me')
      .then((r) => (r.ok ? r.json() : null))
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
        name={me.fullName}
        context="public"
        isMsme={roles.includes('msme')}
        isProvider={roles.includes('provider')}
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
