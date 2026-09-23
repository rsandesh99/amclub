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
 * segments, the selected segment raised on the sunken track.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  ariaLabelledBy,
  size = 'md',
  className,
}: {
  options: readonly SegmentOption<T>[]
  value: T | null
  onChange: (v: T) => void
  ariaLabel?: string
  ariaLabelledBy?: string
  size?: 'sm' | 'md'
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
      id={groupId}
      className={cn('grid auto-cols-fr grid-flow-col gap-0.5 rounded-button bg-sunken p-0.5', className)}
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
              size === 'sm' ? 'min-h-[36px] text-sm' : 'min-h-[44px] text-[15px]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
              selected ? 'bg-surface text-foreground shadow-xs' : 'text-foreground-secondary hover:text-foreground',
            )}
          >
            <span className="truncate">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
