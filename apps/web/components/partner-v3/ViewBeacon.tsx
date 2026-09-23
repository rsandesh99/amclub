'use client'

import { useEffect } from 'react'

/**
 * E11 (N29) — counts one view of a provider profile or package per browser
 * session per day; the server also dedupes, skips bots and the owner. Fire
 * and forget; renders nothing.
 */
export function ViewBeacon({ kind, id }: { kind: 'provider' | 'package'; id: string }) {
  useEffect(() => {
    const key = `amc_view:${kind}:${id}:${new Date().toISOString().slice(0, 10)}`
    try {
      if (sessionStorage.getItem(key)) return
      sessionStorage.setItem(key, '1')
    } catch { /* private mode: the server still dedupes */ }
    void fetch('/api/v1/views', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, id }), keepalive: true }).catch(() => undefined)
  }, [kind, id])
  return null
}
