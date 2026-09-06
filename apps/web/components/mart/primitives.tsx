import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { CountUpNumeral } from './CountUp'

/**
 * AMC Mart UI primitives (FRONTEND.md §2–§3) — thin wrappers over the token
 * classes in globals.css so pages compose from the system, never ad-hoc.
 */

export function SheetCard({ className, children, gold = false }: { className?: string; children: ReactNode; gold?: boolean }) {
  return <div className={cn(gold ? 'gold-edge-card' : 'sheet-card', 'p-4', className)}>{children}</div>
}

/** The richest card in the system — one per screen. Ivory text, gold numerals ≥24px. */
export function EmeraldCard({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('emerald-card jaali-emerald p-5', className)}>{children}</div>
}

/** Jaali-blueprint header band on ivory (home headers, empty states, success). */
export function JaaliHeader({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('jaali-ivory border-b border-brass/40', className)}>
      <div className="mx-auto max-w-6xl px-4 py-8">{children}</div>
    </div>
  )
}

/** Molten-fill progress (0–100). Fills once on mount. */
export function MoltenFill({ value, label }: { value: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)))
  return (
    <div className="space-y-1">
      <div className="molten-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="molten-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** Gold stamp — the brand confirmation gesture. */
export function GoldStamp({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('gold-stamp', className)} aria-hidden="true">
      {children}
    </span>
  )
}

export function LatheSpinner({ className }: { className?: string }) {
  return <span className={cn('lathe-spinner', className)} role="status" aria-label="Loading" />
}

/**
 * Gold display numeral (≥20px bold). Never for small text.
 * Pass `countUpPaise` (server paise) to get the §3.1 #6 count-up on first
 * paint — the final string is server-rendered so there is no CLS; otherwise
 * `children` render as-is.
 */
export function GoldNumeral({ children, className, countUpPaise }: { children?: ReactNode; className?: string; countUpPaise?: number }) {
  return (
    <span className={cn('gold-numeral', className)}>
      {countUpPaise !== undefined ? <CountUpNumeral paise={countUpPaise} /> : children}
    </span>
  )
}
