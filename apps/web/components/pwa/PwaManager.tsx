'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { WifiOff } from 'lucide-react'

/**
 * Phase 8 §5 — registers the service worker and shows a "you're offline"
 * banner while connectivity is down. The SW itself is conservative (see
 * public/sw.js): GET-only, never caches pages or API responses (only static
 * assets + the offline shell); sign-out purges caches via ./purge-caches.
 */
export function PwaManager() {
  const t = useTranslations('common')
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Registration failure (old browser, private mode) — app works without it.
      })
    }
    setOffline(!navigator.onLine)
    const on = () => setOffline(false)
    const off = () => setOffline(true)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  if (!offline) return null
  return (
    <div
      role="status"
      data-bottom-bar className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center gap-2 bg-foreground px-4 py-2.5 text-sm font-medium text-white"
    >
      <WifiOff className="h-4 w-4" aria-hidden />
      {t('offline_banner')}
    </div>
  )
}
