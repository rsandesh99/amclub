'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { formatINR } from '@/lib/format'
import { prefersReducedMotion } from './CountUp'

/**
 * PAISA MOMENT (FRONTEND.md §3.1 #2) — payment success & payout released.
 * Full-screen emerald-deep, a gold coin flips down and lands as a tick,
 * radial shimmer bloom, the amount counts up in gold tabular numerals, the
 * jaali lattice breathes +2% opacity once. ≤1.4s total, then `onDone`; any
 * tap or keypress skips immediately. CSS-only (keyframes live in globals.css,
 * transform/opacity only); the count-up is a single rAF loop.
 *
 * Reduced motion: the final frame renders instantly (CSS base styles are the
 * final state) and `onDone` fires after 900ms.
 *
 * Money is rendered from the server-provided `amountPaise` — never computed.
 */

const TOTAL_MS = 1400
const REDUCED_MS = 900
const COUNT_DELAY_MS = 420
const COUNT_MS = 600

export function PaisaMoment({ kind, amountPaise, onDone, totalMs = TOTAL_MS }: { kind: 'paid' | 'payout'; amountPaise: number; onDone: () => void; /** Experience v3 checkout caps it at 900 ms (FR-5.5); Mart keeps 1.4 s. */ totalMs?: number }) {
  const t = useTranslations('mart')
  // Initial state is the final amount: the numeral is invisible until its
  // 440ms rise (opacity 0 via `both` fill), by which time the effect has
  // already reset it to 0 and started counting. Under reduced motion the
  // final amount is exactly what should be visible on first paint.
  const [shown, setShown] = useState(amountPaise)
  const doneRef = useRef(false)
  const onDoneRef = useRef(onDone)
  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  const finish = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    onDoneRef.current()
  }, [])

  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(amountPaise)
      const id = window.setTimeout(finish, Math.min(totalMs, REDUCED_MS))
      return () => window.clearTimeout(id)
    }
    setShown(0)
    let raf = 0
    let start = 0
    const step = (now: number) => {
      if (start === 0) start = now
      const p = Math.min(1, (now - start) / COUNT_MS)
      const eased = 1 - Math.pow(1 - p, 3)
      setShown(p >= 1 ? amountPaise : Math.round(amountPaise * eased))
      if (p < 1) raf = requestAnimationFrame(step)
    }
    const countTimer = window.setTimeout(() => {
      raf = requestAnimationFrame(step)
    }, COUNT_DELAY_MS)
    const endTimer = window.setTimeout(finish, Math.min(totalMs, TOTAL_MS))
    return () => {
      window.clearTimeout(countTimer)
      window.clearTimeout(endTimer)
      cancelAnimationFrame(raf)
    }
  }, [amountPaise, finish, totalMs])

  // Any keypress skips (tap is handled by the overlay's onClick).
  useEffect(() => {
    const onKey = () => finish()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [finish])

  const title = kind === 'paid' ? t('paisa_paid_title') : t('paisa_payout_title')
  const body = kind === 'paid' ? t('paisa_paid_body') : t('paisa_payout_body')

  return (
    <div
      role="status"
      aria-live="polite"
      onClick={finish}
      className="paisa-overlay fixed inset-0 z-50 flex cursor-pointer select-none items-center justify-center overflow-hidden bg-emerald-hero text-ivory"
    >
      {/* Lattice layer over the same gradient: its 2% opacity breath only moves the jaali + bloom. */}
      <div className="paisa-lattice jaali-emerald absolute inset-0" aria-hidden="true" />

      <div className="relative flex flex-col items-center px-6 text-center">
        {/* Coin + bloom stage */}
        <div className="paisa-stage relative flex h-40 w-40 items-center justify-center" aria-hidden="true">
          <div className="paisa-bloom absolute inset-0 rounded-full" />
          <div className="paisa-coin relative h-24 w-24">
            <div className="paisa-face bg-gold-metal shadow-modal">
              <span className="font-display text-4xl font-bold text-emerald-ink">₹</span>
            </div>
            <div className="paisa-face paisa-face--tick bg-gold-metal shadow-modal">
              <Check className="h-11 w-11 text-emerald-ink" strokeWidth={3} aria-hidden="true" />
            </div>
          </div>
        </div>

        {/* Amount — gold tabular numerals, 36px+ (money display scale). */}
        <p className="paisa-amount gold-numeral mt-2 text-4xl tabular-nums sm:text-5xl">{formatINR(shown)}</p>

        <div className="paisa-copy mt-4">
          <h2 className="font-display text-xl font-bold text-ivory">{title}</h2>
          <p className="mt-1 text-sm text-ivory/80">{body}</p>
          <button
            type="button"
            onClick={finish}
            className="mt-6 rounded-button px-4 py-2 text-xs text-ivory/70 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            {t('paisa_skip')}
          </button>
        </div>
      </div>
    </div>
  )
}
