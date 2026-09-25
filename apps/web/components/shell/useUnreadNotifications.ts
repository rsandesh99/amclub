'use client'

import { useEffect, useSyncExternalStore } from 'react'

/**
 * The unread-notification count, shared by everything that shows it. One
 * module-level store per window: at most one request in flight, nothing
 * refetched within FRESH_MS (so a remounted shell — a route-group change — or a
 * second badge reuses the count instead of firing its own request), one 30 s
 * poll while the tab is visible, and a catch-up when it becomes visible again.
 */
const UNREAD_URL = '/api/v1/notifications?unread=1'
const POLL_MS = 30_000
const FRESH_MS = 10_000

let unread = 0
let fetchedAt = 0
let inflight: Promise<void> | null = null
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function refresh(force = false): Promise<void> {
  if (inflight) return inflight
  if (!force && Date.now() - fetchedAt < FRESH_MS) return Promise.resolve()
  inflight = fetch(UNREAD_URL, { cache: 'no-store' })
    .then(async (res) => {
      // Always drain the body (an unread 401 body keeps the request "in flight" in Chromium).
      const d = (await res.json().catch(() => null)) as { unread?: number } | null
      if (!res.ok || !d) return
      const n = d.unread ?? 0
      if (n !== unread) {
        unread = n
        listeners.forEach((l) => l())
      }
    })
    .catch(() => {})
    .finally(() => {
      fetchedAt = Date.now()
      inflight = null
    })
  return inflight
}

function onVisible() {
  if (document.visibilityState === 'visible') void refresh()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(true) }, POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      if (timer) clearInterval(timer)
      timer = null
      document.removeEventListener('visibilitychange', onVisible)
    }
  }
}

/** The signed-in person's unread count (0 until the first answer). */
export function useUnreadNotifications(): number {
  const n = useSyncExternalStore(subscribe, () => unread, () => 0)
  useEffect(() => { void refresh() }, [])
  return n
}

/** Re-read the count now (after marking notifications read). */
export function invalidateUnreadNotifications(): void {
  // A request already in flight may predate the change: read again after it.
  if (inflight) void inflight.then(() => refresh(true))
  else void refresh(true)
}
