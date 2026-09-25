'use client'

import { useEffect, useState } from 'react'
import type { ProfileMeResponse } from '@amclub/shared'

// S2.3 — shared contract; Partial because the 401 body is {authenticated:false}.
export type PublicMe = Partial<ProfileMeResponse> & { authenticated: boolean }

/** A burst of mounts (the header and the footer of one page) shares one request. */
const REUSE_MS = 5_000
let pending: Promise<PublicMe | null> | null = null
let startedAt = 0

function loadMe(): Promise<PublicMe | null> {
  if (pending && Date.now() - startedAt < REUSE_MS) return pending
  startedAt = Date.now()
  pending = fetch('/api/v1/profile/me', { cache: 'no-store' })
    // Always drain the body — an unread (401) response keeps the request
    // "in flight" in Chromium, so the page never reaches network-idle.
    .then(async (r) => {
      const d = (await r.json().catch(() => null)) as PublicMe | null
      return r.ok && d?.authenticated ? d : null
    })
    .catch(() => null)
  return pending
}

/**
 * The signed-in person on a public (static) page, read on the client so the
 * page stays static / ISR: undefined while unknown, null when signed out.
 */
export function usePublicMe(): PublicMe | null | undefined {
  const [me, setMe] = useState<PublicMe | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void loadMe().then((d) => { if (live) setMe(d) })
    return () => { live = false }
  }, [])
  return me
}
