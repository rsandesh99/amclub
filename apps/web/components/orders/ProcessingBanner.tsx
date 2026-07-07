'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2, ShieldCheck } from 'lucide-react'
import { useRouter } from '@/i18n/navigation'

/**
 * Shown on /app/orders?processing=1 right after a real Razorpay payment.
 * The webhook — not the redirect — creates the order (§2.5), so the order may
 * not exist yet when the buyer lands here. Poll briefly; when a new order
 * shows up, refresh the list and drop the query param. If the webhook is slow,
 * degrade to an honest "payment is safe, check back shortly" — never a dead end.
 */

const POLL_MS = 3000
const MAX_POLLS = 15 // ~45s, then degrade to the slow message

export function ProcessingBanner({ initialCount }: { initialCount: number }) {
  const t = useTranslations('checkout')
  const router = useRouter()
  const [slow, setSlow] = useState(false)
  const polls = useRef(0)

  useEffect(() => {
    let alive = true
    const timer = setInterval(async () => {
      polls.current += 1
      if (polls.current > MAX_POLLS) {
        clearInterval(timer)
        if (alive) setSlow(true)
        return
      }
      try {
        const res = await fetch('/api/v1/orders?role=msme')
        if (!res.ok) return
        const d = await res.json()
        if (alive && (d.orders?.length ?? 0) > initialCount) {
          clearInterval(timer)
          // Drop ?processing=1 and re-render the list with the new order.
          router.replace('/app/orders')
          router.refresh()
        }
      } catch {
        /* transient — keep polling */
      }
    }, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [initialCount, router])

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-5 flex items-start gap-3 rounded-card border border-primary/30 bg-primary-soft/50 p-4"
    >
      {slow ? (
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
      ) : (
        <Loader2 className="mt-0.5 h-5 w-5 shrink-0 text-primary motion-safe:animate-spin" aria-hidden />
      )}
      <div>
        <p className="text-sm font-semibold text-foreground">
          {slow ? t('processing_slow_title') : t('processing_title')}
        </p>
        <p className="mt-0.5 text-sm leading-[1.45] text-foreground-secondary">
          {slow ? t('processing_slow_body') : t('processing_body')}
        </p>
      </div>
    </div>
  )
}
