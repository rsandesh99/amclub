'use client'

import { useEffect, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { Search } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useAnalytics } from '@/components/providers/posthog'
// Loaded on first use (a click or ⌘K) — not on every logged-in page load.
const CommandSearch = dynamic(() => import('./CommandSearch').then((m) => m.CommandSearch), { ssr: false })

/**
 * v3 top bar: material, 56 px. The search trigger (field on desktop with the
 * ⌘K hint, icon on phones) opens the universal search; `trailing` holds the
 * language switch, bell and account menu (server-rendered by the shell).
 */
export function ShellTopBar({ brand, trailing }: { brand: ReactNode; trailing: ReactNode }) {
  const t = useTranslations('search_v3')
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const analytics = useAnalytics()
  const openSearch = () => { setMounted(true); setOpen(true); analytics.capture('command_search_opened', { via: 'button' }) }
  // ⌘K / Ctrl+K before the palette's chunk has loaded: mount it open.
  useEffect(() => {
    if (mounted) return
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setMounted(true); setOpen(true); analytics.capture('command_search_opened', { via: 'keyboard' }) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mounted, analytics])
  return (
    <header className="material hairline-b sticky top-0 z-30">
      <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-3 px-4 lg:px-6">
        {brand}
        <div className="flex flex-1 justify-center">
          <button
            type="button"
            onClick={openSearch}
            className="hidden h-9 w-full max-w-md items-center gap-2 rounded-input bg-sunken px-3 text-left text-[14px] text-foreground-tertiary md:flex"
          >
            <Search className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            <span className="flex-1 truncate">{t('trigger')}</span>
            <kbd className="rounded-[4px] bg-surface px-1.5 font-sans text-[11px] text-foreground-secondary shadow-xs">⌘K</kbd>
          </button>
        </div>
        <button type="button" onClick={openSearch} aria-label={t('trigger')} className="inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground-secondary hover:bg-foreground/5 md:hidden">
          <Search className="h-5 w-5" strokeWidth={1.75} aria-hidden />
        </button>
        <div className="flex h-10 items-center gap-2">{trailing}</div>
      </div>
      {mounted && <CommandSearch open={open} onOpenChange={setOpen} />}
    </header>
  )
}
