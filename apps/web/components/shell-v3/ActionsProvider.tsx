'use client'

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { MeActions } from '@amclub/shared'
import { usePathname } from '@/i18n/navigation'

const Ctx = createContext<{ actions: MeActions | null; refresh: () => void }>({ actions: null, refresh: () => {} })

/**
 * N2 on the client: one fetch of /api/v1/me/actions shared by the rail, the
 * tab bar and home lists; refreshed on navigation and when the tab regains
 * focus (layouts persist across client navigations, so a server read would go stale).
 */
export function ActionsProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<MeActions | null>(null)
  const pathname = usePathname()
  const refresh = useCallback(() => {
    fetch('/api/v1/me/actions', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: MeActions | null) => { if (d) setActions(d) })
      .catch(() => {})
  }, [])
  useEffect(() => { refresh() }, [pathname, refresh])
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onFocus)
    return () => document.removeEventListener('visibilitychange', onFocus)
  }, [refresh])
  return <Ctx.Provider value={{ actions, refresh }}>{children}</Ctx.Provider>
}

export const useMeActions = () => useContext(Ctx)
