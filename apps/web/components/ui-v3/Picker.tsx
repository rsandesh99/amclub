'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { Sheet } from './Sheet'

export interface PickerOption {
  value: string
  label: string
  /** Extra words the search box matches (codes, other scripts). */
  keywords?: string
}

const MAX_RECENT = 4

function readRecent(key?: string): string[] {
  if (!key) return []
  try {
    const raw = localStorage.getItem(`amc_recent_${key}`)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

/**
 * v3 Picker (PRD §3.6) — replaces a native <select> with more than 5
 * options: a field-like button that opens a sheet with search and the
 * viewer's recent picks first. A listbox inside; arrow keys move, Enter picks.
 */
export function Picker({
  label,
  value,
  options,
  onChange,
  placeholder,
  allowClear = false,
  clearLabel,
  recentKey,
  id,
  className,
}: {
  label: string
  value: string | null
  options: readonly PickerOption[]
  onChange: (v: string | null) => void
  placeholder?: string
  /** Adds an "Any" row that clears the value. */
  allowClear?: boolean
  clearLabel?: string
  /** Remember recent picks on this device under this key. */
  recentKey?: string
  id?: string
  className?: string
}) {
  const t = useTranslations('ui')
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [recent, setRecent] = useState<string[]>([])
  const listId = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const selected = options.find((o) => o.value === value) ?? null

  useEffect(() => { if (open) { setRecent(readRecent(recentKey)); setQ(''); setActive(0) } }, [open, recentKey])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const match = (o: PickerOption) => !needle || o.label.toLowerCase().includes(needle) || (o.keywords ?? '').toLowerCase().includes(needle) || o.value.toLowerCase() === needle
    const list = options.filter(match)
    if (needle || recent.length === 0) return list
    const rec = recent.map((v) => options.find((o) => o.value === v)).filter((o): o is PickerOption => !!o)
    return [...rec, ...list.filter((o) => !recent.includes(o.value))]
  }, [q, options, recent])
  const withClear = allowClear && !q
  const total = rows.length + (withClear ? 1 : 0)

  function pick(v: string | null) {
    onChange(v)
    if (v && recentKey) {
      try {
        const next = [v, ...readRecent(recentKey).filter((x) => x !== v)].slice(0, MAX_RECENT)
        localStorage.setItem(`amc_recent_${recentKey}`, JSON.stringify(next))
      } catch { /* storage unavailable — recents are a convenience */ }
    }
    setOpen(false)
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(total - 1, a + 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (withClear && active === 0) pick(null)
      else { const o = rows[active - (withClear ? 1 : 0)]; if (o) pick(o.value) }
    }
  }

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <>
      <button
        type="button"
        id={id}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`${label}: ${selected?.label ?? placeholder ?? ''}`}
        className={cn(
          'flex h-11 w-full items-center justify-between gap-2 rounded-input border border-border bg-surface px-3 text-left text-sm',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          className,
        )}
      >
        <span className={cn('truncate', !selected && 'text-foreground-tertiary')}>{selected?.label ?? placeholder ?? '—'}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-foreground-secondary" strokeWidth={1.75} aria-hidden />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={label} detent="large">
        <div className="sticky top-0 z-10 -mx-5 bg-surface px-5 pb-3">
          <label className="flex h-11 items-center gap-2 rounded-input bg-sunken px-3">
            <Search className="h-4 w-4 text-foreground-secondary" strokeWidth={1.75} aria-hidden />
            <input
              data-autofocus
              value={q}
              onChange={(e) => { setQ(e.target.value); setActive(0) }}
              onKeyDown={onKey}
              placeholder={t('search_placeholder')}
              aria-label={t('search_placeholder')}
              aria-controls={listId}
              aria-activedescendant={`${listId}-${active}`}
              className="min-h-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-foreground-tertiary"
            />
          </label>
        </div>
        <ul ref={listRef} id={listId} role="listbox" aria-label={label} className="grouped">
          {withClear && (
            <li
              id={`${listId}-0`}
              data-idx={0}
              role="option"
              aria-selected={value === null}
              onClick={() => pick(null)}
              className={cn('grouped-row flex cursor-pointer items-center justify-between px-4 text-[15px]', active === 0 && 'bg-primary/5')}
            >
              {clearLabel ?? t('any')}
              {value === null && <Check className="h-4 w-4 text-primary" aria-hidden />}
            </li>
          )}
          {rows.map((o, i) => {
            const idx = i + (withClear ? 1 : 0)
            return (
              <li
                key={o.value}
                id={`${listId}-${idx}`}
                data-idx={idx}
                role="option"
                aria-selected={o.value === value}
                onClick={() => pick(o.value)}
                onMouseEnter={() => setActive(idx)}
                className={cn('grouped-row flex cursor-pointer items-center justify-between gap-3 px-4 text-[15px]', active === idx && 'bg-primary/5')}
              >
                <span className="truncate">{o.label}</span>
                {o.value === value && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
              </li>
            )
          })}
          {rows.length === 0 && <li className="grouped-row px-4 text-[15px] text-foreground-secondary">{t('no_matches')}</li>}
        </ul>
      </Sheet>
    </>
  )
}
