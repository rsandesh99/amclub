'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'

interface ReviewData {
  id: string
  rating: number
  text: string | null
  provider_reply: string | null
  status: string
}

function Stars({ value, onSelect }: { value: number; onSelect?: (n: number) => void }) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={!onSelect}
          onClick={() => onSelect?.(n)}
          aria-label={`${n} star`}
          className={`text-2xl leading-none ${n <= value ? 'text-amber-500' : 'text-gray-300'} ${onSelect ? 'cursor-pointer' : 'cursor-default'}`}
        >
          ★
        </button>
      ))}
    </div>
  )
}

/**
 * Review block on the order workspace (§5.5 / M7). Buyer sees the review prompt
 * + form on a completed order (verified purchase); both parties see the posted
 * review; the provider gets a one-time reply box.
 */
export function ReviewSection({ orderId }: { orderId: string }) {
  const t = useTranslations('reviews')
  const [loading, setLoading] = useState(true)
  const [review, setReview] = useState<ReviewData | null>(null)
  const [canReview, setCanReview] = useState(false)
  const [isProvider, setIsProvider] = useState(false)
  const [rating, setRating] = useState(0)
  const [text, setText] = useState('')
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    try {
      const res = await fetch(`/api/v1/orders/${orderId}/review`)
      if (!res.ok) return
      const d = await res.json()
      setReview(d.review)
      setCanReview(!!d.canReview)
      setIsProvider(!!d.isProvider)
    } finally {
      setLoading(false)
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [orderId])

  async function submitReview() {
    if (rating < 1) { setError(t('pick_rating')); return }
    setBusy(true); setError('')
    try {
      const res = await fetch(`/api/v1/orders/${orderId}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, text: text.trim() || undefined }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : t('failed'))
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('failed'))
    } finally { setBusy(false) }
  }

  async function submitReply() {
    if (!reply.trim()) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`/api/v1/reviews/${review!.id}/reply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: reply.trim() }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : t('failed'))
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('failed'))
    } finally { setBusy(false) }
  }

  if (loading) return null
  // Nothing to show: no review yet and the viewer can't create one.
  if (!review && !canReview) return null

  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card space-y-3">
      <h2 className="text-sm font-semibold">{t('heading')}</h2>

      {/* Buyer: prompt + form (no review yet) */}
      {!review && canReview && (
        <div className="space-y-3">
          <p className="text-sm text-foreground-secondary">{t('prompt')}</p>
          <Stars value={rating} onSelect={setRating} />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder={t('text_placeholder')}
            className="w-full rounded-button border border-border bg-background p-3 text-sm"
          />
          <Button onClick={submitReview} loading={busy}>{t('submit')}</Button>
        </div>
      )}

      {/* Posted review (both parties) */}
      {review && (
        <div className="space-y-3">
          {review.status !== 'published' && (
            <p className="rounded-button bg-warning/10 px-3 py-1.5 text-xs text-warning">{t(`status_${review.status}` as 'status_flagged')}</p>
          )}
          <Stars value={review.rating} />
          {review.text && <p className="text-sm">{review.text}</p>}

          {review.provider_reply ? (
            <div className="rounded-button border-l-2 border-primary/40 bg-primary/5 px-3 py-2">
              <p className="text-xs font-medium text-primary">{t('provider_reply')}</p>
              <p className="text-sm">{review.provider_reply}</p>
            </div>
          ) : isProvider ? (
            <div className="space-y-2">
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={2}
                maxLength={1000}
                placeholder={t('reply_placeholder')}
                className="w-full rounded-button border border-border bg-background p-3 text-sm"
              />
              <Button variant="secondary" onClick={submitReply} loading={busy}>{t('reply_submit')}</Button>
            </div>
          ) : null}
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  )
}
