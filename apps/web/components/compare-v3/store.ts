'use client'

import { useSyncExternalStore } from 'react'

/**
 * Experience v3 E2 FR-2.9 (N34) — the pre-RFQ shortlist: up to 4 packages,
 * kept on this device only (localStorage). No quotes, no chat.
 */
export interface CompareItem {
  id: string
  title: string
}
export const COMPARE_MAX = 4
const KEY = 'amc_compare'
const EVT = 'amc-compare'
const EMPTY: CompareItem[] = []
let cache: { raw: string | null; items: CompareItem[] } = { raw: null, items: EMPTY }

function read(): CompareItem[] {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return EMPTY
  }
  if (raw === cache.raw) return cache.items
  let items: CompareItem[] = EMPTY
  try {
    const v = raw ? JSON.parse(raw) : []
    items = Array.isArray(v)
      ? v.filter((x): x is CompareItem => !!x && typeof x.id === 'string' && /^[0-9a-f-]{36}$/i.test(x.id) && typeof x.title === 'string').slice(0, COMPARE_MAX)
      : EMPTY
  } catch {
    items = EMPTY
  }
  cache = { raw, items }
  return items
}

function write(items: CompareItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(0, COMPARE_MAX)))
  } catch {
    /* private mode — the shortlist just doesn't persist */
  }
  window.dispatchEvent(new Event(EVT))
}

function subscribe(cb: () => void) {
  window.addEventListener(EVT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(EVT, cb)
    window.removeEventListener('storage', cb)
  }
}

export function useCompare(): CompareItem[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY)
}

/** Add or remove; returns the new count, or null when the list is full. */
export function toggleCompare(item: CompareItem): number | null {
  const items = read()
  if (items.some((x) => x.id === item.id)) {
    const next = items.filter((x) => x.id !== item.id)
    write(next)
    return next.length
  }
  if (items.length >= COMPARE_MAX) return null
  const next = [...items, item]
  write(next)
  return next.length
}

export function clearCompare() {
  write([])
}
