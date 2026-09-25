'use client'

import { Bell } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { useUnreadNotifications } from './useUnreadNotifications'

/**
 * Top-bar notification bell with an unread badge. The count comes from the
 * shared store (one request per window, polled while the tab is visible — see
 * useUnreadNotifications); it links to the context's notification centre. RLS
 * scopes the count to the signed-in user.
 */
export function NotificationBell({ href }: { href: string }) {
  const t = useTranslations('notifications')
  const unread = useUnreadNotifications()

  return (
    <Link
      href={href as '/app'}
      // A signed-in, dynamic page: no prefetch on every load (F10).
      prefetch={false}
      aria-label={t('title')}
      className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-surface hover:border-primary/40"
    >
      <Bell className="h-4 w-4 text-foreground-secondary" aria-hidden />
      {unread > 0 && (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </Link>
  )
}
