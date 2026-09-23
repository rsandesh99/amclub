'use client'

/**
 * Experience v3 E2b FR-2.8 (N8) — recently viewed on this device
 * (localStorage, newest first, 20 max). Signed-in buyers also sync to
 * recent_views through /api/v1/me/recent-views.
 */
export interface RecentItem {
  kind: 'provider' | 'package'
  id: string
  title: string
  href: string
  at: number
}
const KEY = 'amc_recent'
export const RECENT_MAX = 20

export function readRecent(): RecentItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v)
      ? v.filter((x): x is RecentItem => !!x && (x.kind === 'provider' || x.kind === 'package') && typeof x.id === 'string' && typeof x.title === 'string' && typeof x.href === 'string' && x.href.startsWith('/p/')).slice(0, RECENT_MAX)
      : []
  } catch {
    return []
  }
}

export function pushRecent(item: Omit<RecentItem, 'at'>) {
  const next = [{ ...item, at: Date.now() }, ...readRecent().filter((x) => !(x.kind === item.kind && x.id === item.id))].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* private mode */
  }
}
