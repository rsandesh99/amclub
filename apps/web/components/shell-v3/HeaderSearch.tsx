'use client'

import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useAnalytics } from '@/components/providers/posthog'
import { cn } from '@/lib/utils'
import { useUniversalSearch } from './useUniversalSearch'
import { UniversalResults } from './UniversalResults'

/**
 * N3 on desktop (≥ md): the top-bar field IS the search box. Typing shows the
 * results in a panel anchored under the field; nothing covers the page. ⌘K /
 * Ctrl+K focuses it (the shell owns the shortcut, see focusHeaderSearch).
 * Phones keep the sheet.
 */
export function HeaderSearch({ fullResultsPath, placeholder, className = 'hidden md:block' }: { fullResultsPath: string; placeholder?: string; className?: string }) {
  const t = useTranslations('search_v3')
  const analytics = useAnalytics()
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const s = useUniversalSearch({
    fullResultsPath,
    onNavigate: () => { setOpen(false); s.reset(); input.current?.blur() },
  })

  // Close on a pointer-down anywhere outside the field and its panel.
  useEffect(() => {
    if (!open) return
    function onDown(e: PointerEvent) {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  function onFocus() {
    if (!open) {
      s.refreshRecent()
      setOpen(true)
      analytics.capture('command_search_opened', { via: 'field' })
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (s.q) s.reset()
      else { setOpen(false); input.current?.blur() }
      return
    }
    if (!open) setOpen(true)
    s.onKey(e)
  }

  const listId = 'header-search-list'
  return (
    <div
      ref={box}
      className={cn('relative w-full max-w-xl', className)}
      // Tabbing out of the field and its panel closes it.
      onBlur={(e) => { const next = e.relatedTarget as Node | null; if (next && !box.current?.contains(next)) setOpen(false) }}
    >
      <label className="flex h-9 w-full items-center gap-2 rounded-input bg-sunken px-3 text-[14px] focus-within:ring-2 focus-within:ring-primary/40">
        <Search className="h-4 w-4 shrink-0 text-foreground-tertiary" strokeWidth={1.75} aria-hidden />
        <input
          ref={input}
          value={s.q}
          onChange={(e) => { s.setQ(e.target.value); if (!open) setOpen(true) }}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? t('trigger')}
          aria-label={placeholder ?? t('trigger')}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          // Only while the list exists: a dangling id reference is an axe violation.
          aria-controls={open && s.rows.length > 0 ? listId : undefined}
          aria-activedescendant={open && s.rows[s.active] ? `${listId}-${s.active}` : undefined}
          className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-foreground-tertiary"
          data-testid="header-search"
          data-header-search
        />
        {s.q ? (
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { s.reset(); input.current?.focus() }} aria-label={t('clear')} className="inline-flex h-6 w-6 items-center justify-center rounded-full text-foreground-secondary hover:bg-foreground/5">
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : (
          <kbd className="rounded-[4px] bg-surface px-1.5 font-sans text-[11px] text-foreground-secondary shadow-xs" aria-hidden>⌘K</kbd>
        )}
      </label>

      {open && (
        <div
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-40 max-h-[min(70vh,560px)] overflow-y-auto overscroll-contain rounded-card border border-border bg-surface p-3 shadow-modal"
          data-testid="header-search-panel"
        >
          <UniversalResults
            listId={listId}
            q={s.q}
            rows={s.rows}
            active={s.active}
            setActive={s.setActive}
            loading={s.loading}
            hasResult={s.res !== null}
            recent={s.recent}
            onRecent={(r) => { s.setQ(r); input.current?.focus() }}
            onPick={(href) => s.go(href, s.q.trim())}
          />
          {s.q.trim().length >= 2 && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => s.go(`${fullResultsPath}?query=${encodeURIComponent(s.q.trim())}`, s.q.trim())}
              className="mt-2 flex w-full items-center gap-2 rounded-button px-3 py-2.5 text-left text-[14px] font-medium text-primary hover:bg-primary/5"
            >
              <Search className="h-4 w-4" aria-hidden />
              {t('see_all_results', { q: s.q.trim() })}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
