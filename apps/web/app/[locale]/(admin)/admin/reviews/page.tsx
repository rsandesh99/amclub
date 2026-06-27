'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'

interface Review {
  id: string
  rating: number
  text: string | null
  status: string
  created_at: string
  provider: { display_name: string; slug: string } | null
}

export default function AdminReviewsPage() {
  const t = useTranslations('admin_reviews')
  const [reviews, setReviews] = useState<Review[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  async function load() {
    try {
      const res = await fetch('/api/v1/admin/reviews?status=flagged', { cache: 'no-store' })
      if (res.ok) setReviews((await res.json()).reviews ?? [])
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function moderate(id: string, action: 'remove' | 'restore') {
    setBusy(id)
    try {
      const res = await fetch(`/api/v1/admin/reviews/${id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (res.ok) setReviews((prev) => prev.filter((r) => r.id !== id))
    } finally { setBusy(null) }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
      <p className="text-sm text-foreground-secondary">{t('subtitle')}</p>

      {loading ? (
        <p className="text-sm text-foreground-secondary">{t('loading')}</p>
      ) : reviews.length === 0 ? (
        <div className="rounded-card border border-border bg-surface p-10 text-center text-sm text-foreground-secondary">{t('empty')}</div>
      ) : (
        <ul className="space-y-3">
          {reviews.map((r) => (
            <li key={r.id} className="rounded-card border border-border bg-surface p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-amber-500">{'★'.repeat(r.rating)}<span className="text-gray-300">{'★'.repeat(5 - r.rating)}</span></span>
                <span className="text-xs text-foreground-secondary">{r.provider?.display_name}</span>
              </div>
              {r.text && <p className="text-sm">{r.text}</p>}
              <div className="flex gap-2">
                <Button variant="danger" onClick={() => moderate(r.id, 'remove')} loading={busy === r.id}>{t('remove')}</Button>
                <Button variant="outline" onClick={() => moderate(r.id, 'restore')} loading={busy === r.id}>{t('restore')}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
