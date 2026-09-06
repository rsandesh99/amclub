'use client'

import { useEffect, useRef, useState } from 'react'
import { formatINR, formatINRExact } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Count-up numerals (FRONTEND.md §3.1 #6): money animates 300–600ms on first
 * paint. Performance contract:
 *  - Server HTML renders the FINAL string, so there is no CLS and nothing
 *    runs before first paint; the animation replaces text only after
 *    hydration.
 *  - A visibility-hidden ghost of the final string reserves the width in the
 *    same grid cell, so the element never gets narrower while counting.
 *  - requestAnimationFrame, ease-out cubic, cancelled on unmount.
 *  - prefers-reduced-motion → final value immediately, no animation.
 * Subsequent `paise` changes (e.g. cart qty edits) ease from the previous
 * shown value rather than restarting from 0.
 */

const MIN_MS = 300
const MAX_MS = 600

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Duration scales with magnitude: ₹10 → 300ms, ₹1,00,000+ → 600ms. */
function durationFor(deltaPaise: number): number {
  const rupees = Math.abs(deltaPaise) / 100
  if (rupees <= 1) return MIN_MS
  const scaled = MIN_MS + (Math.log10(rupees) / 5) * (MAX_MS - MIN_MS)
  return Math.max(MIN_MS, Math.min(MAX_MS, Math.round(scaled)))
}

export function CountUpNumeral({ paise, className, exact = false }: { paise: number; className?: string; exact?: boolean }) {
  const fmt = exact ? formatINRExact : formatINR
  const [shown, setShown] = useState(paise)
  // Last value the user actually saw — the start of the next tween. Starts at
  // 0 so the very first client render counts up from nothing.
  const lastShownRef = useRef(0)

  useEffect(() => {
    const from = lastShownRef.current
    if (from === paise || prefersReducedMotion()) {
      lastShownRef.current = paise
      setShown(paise)
      return
    }
    const duration = durationFor(paise - from)
    let raf = 0
    let start = 0
    const step = (now: number) => {
      if (start === 0) start = now
      const p = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      const value = p >= 1 ? paise : Math.round(from + (paise - from) * eased)
      lastShownRef.current = value
      setShown(value)
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [paise])

  const finalText = fmt(paise)
  return (
    <span className={cn('inline-grid tabular-nums', className)}>
      {/* Ghost reserves the final width so the visible numeral never shifts layout. */}
      <span aria-hidden="true" className="invisible [grid-area:1/1]">
        {finalText}
      </span>
      <span className="justify-self-end [grid-area:1/1]">{shown === paise ? finalText : fmt(shown)}</span>
    </span>
  )
}
