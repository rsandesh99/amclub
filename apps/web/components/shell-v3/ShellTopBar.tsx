'use client'

import { useEffect, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { Search } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useAnalytics } from '@/components/providers/posthog'
import { HeaderSearch } from './HeaderSearch'
import { focusHeaderSearch } from './focus-header-search'
// The phone sheet loads on first use (a tap or ⌘K) — not on every logged-in page load.
const CommandSearch = dynamic(() => import('./CommandSearch').then((m) => m.CommandSearch), { ssr: false })

/**
 * v3 top bar: material, 56 px. On desktop the search field is typed into in
 * place (HeaderSearch, results in a panel under it); on phones the icon opens
 * the search sheet. ⌘K / Ctrl+K does whichever fits the screen. `trailing`
 * holds the language switch, bell and account menu (server-rendered).
 */
export function ShellTopBar({ brand, trailing, fullResultsPath = '/app/search' }: { brand: ReactNode; trailing: ReactNode; fullResultsPath?: string }) {
  const t = useTranslations('search_v3')
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const analytics = useAnalytics()

  const openSheet = (via: 'button' | 'keyboard') => { setMounted(true); setOpen(true); analytics.capture('command_search_opened', { via }) }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) return
      e.preventDefault()
      if (!focusHeaderSearch()) openSheet('keyboard')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // openSheet only closes over stable setters and analytics.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analytics])

  return (
    <header className="material hairline-b sticky top-0 z-30">
      {/* Phones (360–390 px): the row must fit brand + search + language + bell + avatar with
          no sideways scroll — tighter gaps, no empty spacer (the search icon takes ml-auto),
          and the trailing cluster may shrink (the language select clips before anything overflows). */}
      <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-2 px-4 sm:gap-3 lg:px-6">
        {brand}
        <div className="hidden flex-1 justify-center md:flex">
          <HeaderSearch fullResultsPath={fullResultsPath} />
        </div>
        <button type="button" onClick={() => openSheet('button')} aria-label={t('trigger')} className="ml-auto inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-foreground-secondary hover:bg-foreground/5 md:hidden">
          <Search className="h-5 w-5" strokeWidth={1.75} aria-hidden />
        </button>
        <div className="flex h-10 min-w-0 items-center gap-1 sm:gap-2">{trailing}</div>
      </div>
      {mounted && <CommandSearch open={open} onOpenChange={setOpen} fullResultsPath={fullResultsPath} />}
    </header>
  )
}
