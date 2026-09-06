'use client'

import { useEffect, useState } from 'react'
import { Bell } from 'lucide-react'
import { Link } from '@/i18n/navigation'

/**
 * Top-bar notification bell with an unread badge. Polls the cheap count endpoint
 * (head request) and links to the context's notification centre. RLS scopes the
 * count to the signed-in user.
 */
export function NotificationBell({ href }: { href: string }) {
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    let alive = true
    async function poll() {
      try {
        const res = await fetch('/api/v1/notifications?unread=1', { cache: 'no-store' })
        if (!res.ok) return
        const d = await res.json()
        if (alive) setUnread(d.unread ?? 0)
      } catch { /* ignore */ }
    }
    poll()
    const t = setInterval(poll, 30_000)
    // Catch up immediately when the user returns to the tab.
    window.addEventListener('focus', poll)
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', poll) }
  }, [])

  return (
    <Link
      href={href as '/app'}
      aria-label="Notifications"
      className="relative flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface hover:border-primary/40"
    >
      <Bell className="h-4 w-4 text-foreground-secondary" />
      {unread > 0 && (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </Link>
  )
}
