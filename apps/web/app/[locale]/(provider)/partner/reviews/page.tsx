'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'

interface Review {
  id: string
  rating: number
  text: string | null
  provider_reply: string | null
  status: string
  created_at: string
  order: { order_number: string; title: string } | null
}

function Stars({ value }: { value: number }) {
  return <span className="text-amber-500">{'★'.repeat(value)}<span className="text-gray-300">{'★'.repeat(5 - value)}</span></span>
}

export default function PartnerReviewsPage() {
  const t = useTranslations('reviews')
  const [reviews, setReviews] = useState<Review[]>([])
  const [avg, setAvg] = useState('0.0')
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  async function load() {
    try {
      const res = await fetch('/api/v1/partner/reviews', { cache: 'no-store' })
      if (res.ok) {
        const d = await res.json()
        setReviews(d.reviews ?? [])
        setAvg(d.avgRating ?? '0.0')
        setCount(d.reviewCount ?? 0)
      }
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function reply(id: string) {
    const body = (drafts[id] ?? '').trim()
    if (!body) return
    setBusy(id)
    try {
      const res = await fetch(`/api/v1/reviews/${id}/reply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: body }),
      })
      if (res.ok) { setDrafts((d) => ({ ...d, [id]: '' })); await load() }
    } finally { setBusy(null) }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 space-y-4">
      <div className="flex items-end justify-between">
        <h1 className="font-display text-xl font-bold">{t('partner_title')}</h1>
        {/* QA F33 — no "★ 0.0 · 0 reviews" line: with no reviews the empty state below says so. */}
        {!loading && count > 0 && <p className="text-sm text-foreground-secondary">★ {avg} · {count} {t('count_label')}</p>}
      </div>

      {loading ? (
        <p className="text-sm text-foreground-secondary">{t('loading')}</p>
      ) : reviews.length === 0 ? (
        <div className="rounded-card border border-border bg-surface p-10 text-center">
          <p className="text-3xl">⭐</p>
          <p className="mt-2 text-sm text-foreground-secondary">{t('partner_empty')}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {reviews.map((r) => (
            <li key={r.id} className="rounded-card border border-border bg-surface p-4 space-y-2">
              <div className="flex items-center justify-between">
                <Stars value={r.rating} />
                <span className="text-xs text-foreground-secondary">{r.order?.order_number}</span>
              </div>
              {r.text && <p className="text-sm">{r.text}</p>}
              {r.status === 'flagged' && <p className="text-xs text-warning">{t('status_flagged')}</p>}

              {r.provider_reply ? (
                <div className="rounded-button border-l-2 border-primary/40 bg-primary/5 px-3 py-2">
                  <p className="text-xs font-medium text-primary">{t('provider_reply')}</p>
                  <p className="text-sm">{r.provider_reply}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <textarea
                    rows={2}
                    maxLength={1000}
                    value={drafts[r.id] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                    placeholder={t('reply_placeholder')}
                    className="w-full rounded-button border border-border bg-background p-2.5 text-sm"
                  />
                  <Button variant="secondary" onClick={() => reply(r.id)} loading={busy === r.id}>{t('reply_submit')}</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
