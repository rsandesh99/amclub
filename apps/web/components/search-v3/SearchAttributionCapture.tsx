'use client'

import { useEffect } from 'react'

/**
 * E15 F5 — the package page (ISR, so no searchParams on the server) keeps the
 * search that led here: `?sid=&pos=` → sessionStorage, keyed to this package.
 * Checkout sends it with the session; nothing is shown and nothing identifies
 * the buyer.
 */
export const SEARCH_ATTR_KEY = 'amc_search_attr'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function SearchAttributionCapture({ packageIds }: { packageIds: string[] }) {
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search)
      const sid = q.get('sid')
      if (!sid || !UUID.test(sid)) return
      const pos = Number(q.get('pos'))
      window.sessionStorage.setItem(SEARCH_ATTR_KEY, JSON.stringify({ packageIds, search_id: sid, ...(Number.isInteger(pos) && pos > 0 && pos <= 500 ? { position: pos } : {}), at: Date.now() }))
    } catch {
      /* storage unavailable: no attribution */
    }
  }, [packageIds])
  return null
}

/** The attribution for a checkout of `packageId`, if this tab came from a search in the last 24 hours. */
export function readSearchAttribution(packageId: string): { search_id: string; position?: number } | null {
  try {
    const raw = window.sessionStorage.getItem(SEARCH_ATTR_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { packageIds?: string[]; search_id?: string; position?: number; at?: number }
    if (!v.search_id || !UUID.test(v.search_id) || !v.packageIds?.includes(packageId) || !v.at || Date.now() - v.at > 24 * 3600e3) return null
    return { search_id: v.search_id, ...(v.position ? { position: v.position } : {}) }
  } catch {
    return null
  }
}
