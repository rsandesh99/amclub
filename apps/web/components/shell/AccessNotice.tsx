'use client'

import { useEffect, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ShieldAlert, X } from 'lucide-react'

/** The query flag the admin layout adds when it sends a signed-in non-admin away. */
export const ACCESS_DENIED_PARAM = 'denied'

/**
 * A short notice at the top of the shell after a redirect for lack of access
 * (today: /admin for a non-admin → `/app?denied=admin`). The flag is removed
 * from the address at once, so a reload or a copied link does not repeat it;
 * the notice stays until closed or the next navigation.
 */
export function AccessNotice() {
  const t = useTranslations()
  const params = useSearchParams()
  const pathname = usePathname()
  const [shownOn, setShownOn] = useState<string | null>(null)

  useEffect(() => {
    if (params.get(ACCESS_DENIED_PARAM) !== 'admin') return
    setShownOn(pathname)
    const next = new URLSearchParams(params.toString())
    next.delete(ACCESS_DENIED_PARAM)
    const qs = next.toString()
    // Native history integrates with the App Router (no refetch, useSearchParams follows).
    window.history.replaceState(null, '', `${pathname}${qs ? `?${qs}` : ''}${window.location.hash}`)
  }, [params, pathname])

  if (!shownOn || shownOn !== pathname) return null
  return (
    <div role="status" className="mx-4 mt-4 flex items-start gap-3 rounded-card border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-foreground" data-testid="access-notice">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
      <p className="min-w-0 flex-1">{t('admin.access_denied')}</p>
      <button type="button" onClick={() => setShownOn(null)} aria-label={t('common.close')} className="-my-2.5 -mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground-secondary hover:bg-foreground/5">
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  )
}
