'use client'

import { useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { pickI18n } from '@/lib/format'
import { readRecent, type RecentItem } from './store'

type ServerItem = { kind: 'provider' | 'package'; id: string; title: { en: string; hi?: string }; href: string; viewedAt: string }

/**
 * FR-2.8 — this device's recently viewed list merged with the account's
 * (signed in), newest first. Shared by "Recently viewed" (E2b) and the home's
 * "Pick up where you left off" shelf (E9 FR-9.2).
 */
export function useRecentItems(): RecentItem[] {
  const locale = useLocale()
  const [items, setItems] = useState<RecentItem[]>([])
  useEffect(() => {
    let live = true
    const local = readRecent()
    setItems(local)
    fetch('/api/v1/me/recent-views')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { items?: ServerItem[] } | null) => {
        if (!live || !j?.items) return
        const merged = new Map<string, RecentItem>()
        for (const s of j.items) merged.set(`${s.kind}:${s.id}`, { kind: s.kind, id: s.id, title: pickI18n(s.title, locale), href: s.href, at: Date.parse(s.viewedAt) })
        for (const l of local) {
          const k = `${l.kind}:${l.id}`
          const prev = merged.get(k)
          if (!prev || l.at > prev.at) merged.set(k, l)
        }
        setItems([...merged.values()].sort((a, b) => b.at - a.at))
      })
      .catch(() => {})
    return () => { live = false }
  }, [locale])
  return items
}
