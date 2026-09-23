'use client'

import { useEffect } from 'react'
import { pushRecent } from './store'

/** Records one view of a provider / package page (device list + account sync). */
export function RecentViewTracker({ kind, id, title, href }: { kind: 'provider' | 'package'; id: string; title: string; href: string }) {
  useEffect(() => {
    pushRecent({ kind, id, title, href })
    // Signed-out: 401, ignored. Signed-in: kept on the account (newest 20).
    void fetch('/api/v1/me/recent-views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, refId: id }),
    }).catch(() => {})
  }, [kind, id, title, href])
  return null
}
