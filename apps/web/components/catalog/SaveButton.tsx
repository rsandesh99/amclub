'use client'

import { useEffect, useState } from 'react'
import { Heart } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { cn } from '@/lib/utils'

/**
 * Save/shortlist toggle for a provider. Checks current saved state on mount;
 * if the user isn't authenticated, sends them to login with a return path.
 */
export function SaveButton({
  providerId,
  returnPath,
}: {
  providerId: string
  returnPath: string
}) {
  const t = useTranslations('catalog')
  const router = useRouter()
  const [saved, setSaved] = useState(false)
  const [authed, setAuthed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    fetch('/api/v1/saved')
      .then((r) => (r.ok ? r.json() : { providerIds: [] }))
      .then((d: { providerIds?: string[] }) => {
        if (!active) return
        setAuthed(Array.isArray(d.providerIds))
        setSaved(Boolean(d.providerIds?.includes(providerId)))
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [providerId])

  async function toggle() {
    setBusy(true)
    const res = await fetch('/api/v1/saved', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, action: saved ? 'unsave' : 'save' }),
    })
    setBusy(false)
    if (res.status === 401) {
      router.push(`/login?next=${encodeURIComponent(returnPath)}`)
      return
    }
    if (res.ok) {
      const d = await res.json()
      setSaved(Boolean(d.saved))
      setAuthed(true)
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={saved}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-button border px-3 py-1.5 text-sm font-medium transition-colors',
        saved && authed
          ? 'border-danger bg-danger/10 text-danger'
          : 'border-gray-200 text-foreground-secondary hover:border-danger/40 hover:text-danger',
      )}
    >
      <Heart className={cn('h-4 w-4', saved && authed && 'fill-danger')} />
      {saved && authed ? t('saved') : t('save')}
    </button>
  )
}
