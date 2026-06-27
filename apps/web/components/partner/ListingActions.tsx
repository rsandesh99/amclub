'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Pause, Play, Pencil, Trash2 } from 'lucide-react'
import { Link, useRouter } from '@/i18n/navigation'

export function ListingActions({
  packageId,
  status,
}: {
  packageId: string
  status: string
}) {
  const t = useTranslations('listings')
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function setStatus(next: 'active' | 'paused') {
    setBusy(true)
    await fetch(`/api/v1/partner/packages/${packageId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next }),
    })
    setBusy(false)
    router.refresh()
  }

  async function remove() {
    if (!confirm(t('confirm_delete'))) return
    setBusy(true)
    await fetch(`/api/v1/partner/packages/${packageId}`, { method: 'DELETE' })
    setBusy(false)
    router.refresh()
  }

  return (
    <div className="flex items-center gap-1">
      <Link
        href={`/partner/listings/${packageId}/edit`}
        className="inline-flex items-center gap-1 rounded-button px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
      >
        <Pencil className="h-3.5 w-3.5" /> {t('edit')}
      </Link>
      {status === 'active' ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => setStatus('paused')}
          className="inline-flex items-center gap-1 rounded-button px-2.5 py-1.5 text-xs font-medium text-foreground-secondary hover:bg-muted"
        >
          <Pause className="h-3.5 w-3.5" /> {t('pause')}
        </button>
      ) : status === 'paused' || status === 'draft' ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => setStatus('active')}
          className="inline-flex items-center gap-1 rounded-button px-2.5 py-1.5 text-xs font-medium text-success hover:bg-success/10"
        >
          <Play className="h-3.5 w-3.5" /> {t('publish')}
        </button>
      ) : null}
      <button
        type="button"
        disabled={busy}
        onClick={remove}
        className="inline-flex items-center gap-1 rounded-button px-2.5 py-1.5 text-xs font-medium text-danger hover:bg-danger/10"
      >
        <Trash2 className="h-3.5 w-3.5" /> {t('delete')}
      </button>
    </div>
  )
}
