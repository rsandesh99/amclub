'use client'

import { useRef, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'

export interface SectionTab<T extends string> {
  value: T
  label: string
  /** An unread / pending count shown beside the label. */
  badge?: number
}

/**
 * PRD Experience v3 E8 FR-8.3 — the order's section tabs. A real tablist:
 * one tab stop, arrow keys / Home / End move and select, scrolls sideways on a
 * phone. Panels stay in the page (hidden), so nothing depends on a click.
 */
export function SectionTabs<T extends string>({ tabs, value, onChange, idPrefix, label }: { tabs: readonly SectionTab<T>[]; value: T; onChange: (v: T) => void; idPrefix: string; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const current = Math.max(0, tabs.findIndex((x) => x.value === value))

  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const last = tabs.length - 1
    let to = -1
    if (e.key === 'ArrowRight') to = i === last ? 0 : i + 1
    if (e.key === 'ArrowLeft') to = i === 0 ? last : i - 1
    if (e.key === 'Home') to = 0
    if (e.key === 'End') to = last
    if (to < 0) return
    e.preventDefault()
    onChange(tabs[to]!.value)
    refs.current[to]?.focus()
  }

  return (
    <div role="tablist" aria-label={label} className="hairline-b -mx-4 flex gap-1 overflow-x-auto px-4">
      {tabs.map((tab, i) => {
        const selected = i === current
        return (
          <button
            key={tab.value}
            ref={(el) => { refs.current[i] = el }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.value}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.value}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              'relative min-h-[44px] shrink-0 whitespace-nowrap px-3 text-sm font-medium transition-colors',
              selected ? 'text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary' : 'text-foreground-secondary hover:text-foreground',
            )}
          >
            {tab.label}
            {tab.badge ? <span className="ml-1.5 rounded-chip bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-white">{tab.badge}</span> : null}
          </button>
        )
      })}
    </div>
  )
}
