'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'

/** Stored copy: en always; hi / te / ta only where the event carries them. */
type NotifText = { en: string; hi?: string; te?: string; ta?: string }

interface Notif {
  id: string
  kind: string
  title_i18n: NotifText
  body_i18n: NotifText
  link: string | null
  read_at: string | null
  created_at: string
}

/** The active locale's text, en when this notification has no copy in it. */
function pick(t: NotifText | null | undefined, locale: string): string {
  if (!t) return ''
  const v = (t as Record<string, string | undefined>)[locale]
  return v && v.trim() !== '' ? v : t.en
}

const DATE_LOCALE: Record<string, string> = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN', ta: 'ta-IN' }

/** Notification centre (§3.7 list view). Renders in the recipient's locale
 *  (any supported locale, en fallback), marks read on click, and supports mark-all-read. */
export function NotificationCenter() {
  const t = useTranslations('notifications')
  const locale = useLocale()
  const router = useRouter()
  const [items, setItems] = useState<Notif[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    try {
      const res = await fetch('/api/v1/notifications', { cache: 'no-store' })
      if (res.ok) setItems((await res.json()).notifications ?? [])
    } finally { setLoading(false) }
  }
  useEffect(() => {
    load()
    // Keep the list fresh while the page is open (H4) — new notifications
    // otherwise only appeared after a full reload.
    const t = setInterval(load, 30_000)
    window.addEventListener('focus', load)
    return () => { clearInterval(t); window.removeEventListener('focus', load) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function markRead(id?: string) {
    await fetch('/api/v1/notifications/read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(id ? { id } : { all: true }),
    })
    setItems((prev) => prev.map((n) => (!id || n.id === id ? { ...n, read_at: new Date().toISOString() } : n)))
  }

  async function open(n: Notif) {
    if (!n.read_at) await markRead(n.id)
    if (n.link) router.push(n.link as '/app')
  }

  const unread = items.filter((n) => !n.read_at).length

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl font-bold">{t('title')}</h1>
        {unread > 0 && (
          <button type="button" onClick={() => markRead()} className="text-sm text-trust underline">
            {t('mark_all_read')}
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-foreground-secondary">{t('loading')}</p>
      ) : items.length === 0 ? (
        <div className="rounded-card border border-border bg-surface p-10 text-center">
          <p className="text-3xl">🔔</p>
          <p className="mt-2 text-sm text-foreground-secondary">{t('empty')}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => open(n)}
                className={`flex w-full items-start gap-3 rounded-card border p-4 text-left transition ${
                  n.read_at ? 'border-border bg-surface' : 'border-primary/30 bg-primary/5'
                }`}
              >
                {!n.read_at && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
                <div className={n.read_at ? 'pl-5' : ''}>
                  <p className="text-sm font-medium">{pick(n.title_i18n, locale)}</p>
                  <p className="text-sm text-foreground-secondary">{pick(n.body_i18n, locale)}</p>
                  <p className="mt-1 text-xs text-foreground-secondary">
                    {new Date(n.created_at).toLocaleString(DATE_LOCALE[locale] ?? 'en-IN', { timeZone: 'Asia/Kolkata' })} IST
                  </p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
