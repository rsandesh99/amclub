'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'

/**
 * Search with suggestions. Progressive: it is a plain GET form to /mart/search
 * that works before hydration; suggestions arrive from the edge-cached
 * /api/v1/mart/products/suggest after 180ms of quiet typing.
 */
export function SearchBox({ defaultValue = '', category }: { defaultValue?: string; category?: string }) {
  const t = useTranslations('mart')
  const router = useRouter()
  const listId = useId()
  const [q, setQ] = useState(defaultValue)
  const [sugg, setSugg] = useState<{ id: string; name: string; brand: string | null }[]>([])
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    if (q.trim().length < 2) { setSugg([]); return }
    timer.current = setTimeout(async () => {
      const res = await fetch(`/api/v1/mart/products/suggest?q=${encodeURIComponent(q.trim())}`)
      if (!res.ok) return
      const d = (await res.json()) as { suggestions: { id: string; name: string; brand: string | null }[] }
      setSugg(d.suggestions)
      setOpen(true)
    }, 180)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [q])

  return (
    <form action="/mart/search" method="get" role="search" className="relative flex max-w-xl gap-2" onSubmit={() => setOpen(false)}>
      {category && <input type="hidden" name="category" value={category} />}
      <input
        type="search"
        name="query"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => sugg.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={t('search_placeholder')}
        aria-label={t('search_btn')}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        autoComplete="off"
        className="field-control min-w-0 flex-1 border-brass/60 bg-ivory text-body"
      />
      <button type="submit" className="h-11 shrink-0 rounded-button bg-emerald px-5 text-sm font-semibold text-ivory hover:bg-emerald-ink">
        {t('search_btn')}
      </button>
      {open && sugg.length > 0 && (
        <ul id={listId} role="listbox" className="absolute left-0 right-0 top-12 z-20 overflow-hidden rounded-[10px] border border-brass/50 bg-ivory shadow-sheet">
          {sugg.map((s) => (
            <li key={s.id} role="option" aria-selected={false}>
              <button
                type="button"
                className="flex h-12 w-full items-center justify-between px-3 text-left text-meta text-emerald-ink hover:bg-emerald/10"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => router.push(`/mart/p/${s.id}` as '/services')}
              >
                <span className="truncate">{s.name}</span>
                {s.brand && <span className="ml-2 shrink-0 text-xs text-foreground-secondary">{s.brand}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}
