'use client'

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  /** Accessible name when `label` is an icon. */
  ariaLabel?: string
}

/**
 * v3 SegmentedControl (PRD §3.6) — replaces a native <select> with ≤ 5
 * options. A radio group: one tab stop, arrow keys move and select, 44 dp
 * segments, the selected segment raised on the sunken track. `wrap` lets
 * long labels (data-driven options such as "₹20 lakh – ₹1 crore") flow onto
 * more rows instead of truncating in equal columns.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  invalid = false,
  size = 'md',
  wrap = false,
  className,
}: {
  options: readonly SegmentOption<T>[]
  value: T | null
  onChange: (v: T) => void
  ariaLabel?: string
  ariaLabelledBy?: string
  ariaDescribedBy?: string | undefined
  invalid?: boolean
  size?: 'sm' | 'md'
  /** Segments size to their labels and wrap onto more rows (labels never truncate). */
  wrap?: boolean
  className?: string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const groupId = useId()
  const current = Math.max(0, options.findIndex((o) => o.value === value))

  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const last = options.length - 1
    let to = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = i === last ? 0 : i + 1
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = i === 0 ? last : i - 1
    if (e.key === 'Home') to = 0
    if (e.key === 'End') to = last
    if (to < 0) return
    e.preventDefault()
    onChange(options[to]!.value)
    refs.current[to]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      aria-invalid={invalid || undefined}
      id={groupId}
      className={cn(wrap ? 'flex flex-wrap' : 'grid auto-cols-fr grid-flow-col', 'gap-0.5 rounded-button bg-sunken p-0.5', invalid && 'ring-1 ring-danger', className)}
    >
      {options.map((o, i) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[i] = el }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o.ariaLabel}
            tabIndex={i === current ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              'segment-thumb inline-flex min-w-0 items-center justify-center rounded-[8px] px-3 font-medium',
              wrap && 'flex-auto py-1',
              size === 'sm' ? 'min-h-[36px] text-sm' : 'min-h-[44px] text-[15px]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
              selected ? 'bg-surface text-foreground shadow-xs' : 'text-foreground-secondary hover:text-foreground',
            )}
          >
            <span className={wrap ? 'text-center leading-tight [overflow-wrap:anywhere]' : 'truncate'}>{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
