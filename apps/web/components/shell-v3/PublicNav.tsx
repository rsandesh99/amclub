'use client'

import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { ChevronDown, Menu, Search } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { Link, usePathname } from '@/i18n/navigation'
import { cn } from '@/lib/utils'
import { pickI18n } from '@/lib/format'
import type { I18nText } from '@amclub/shared'
import { CategoryIcon } from '@/components/catalog/CategoryIcon'
import { useAnalytics } from '@/components/providers/posthog'

// Loaded on first open only — every public page carries this header (§3.8 JS budget).
const Sheet = dynamic(() => import('@/components/ui-v3/Sheet').then((m) => m.Sheet), { ssr: false })
const CommandSearch = dynamic(() => import('./CommandSearch').then((m) => m.CommandSearch), { ssr: false })

export interface NavCategory {
  slug: string
  name: I18nText
  description: I18nText | null
  icon: string | null
}

/**
 * v3 public navigation (PRD E1 FR-1.3 / §4.2): a Services menu over the
 * categories (level-2 services join it in E2), universal search and the
 * always-visible "Post a requirement". Phones: search icon + a menu sheet.
 */
export function PublicNav({ categories }: { categories: NavCategory[] }) {
  const t = useTranslations('public_nav')
  const locale = useLocale()
  const pathname = usePathname()
  const analytics = useAnalytics()
  const [menu, setMenu] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [search, setSearchState] = useState(false)
  const [searchMounted, setSearchMounted] = useState(false)
  const setSearch = (o: boolean) => { if (o) setSearchMounted(true); setSearchState(o) }
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => { setMenu(false); setSheet(false) }, [pathname])
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => { if (panel.current && !panel.current.contains(e.target as Node)) setMenu(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [menu])

  return (
    <>
      <div ref={panel} className="relative hidden md:block">
        <button
          type="button"
          aria-expanded={menu}
          aria-controls="services-menu"
          onClick={() => setMenu((m) => !m)}
          className="inline-flex h-10 items-center gap-1 rounded-button px-3 text-[15px] font-medium text-foreground hover:bg-foreground/5"
        >
          {t('services')}
          <ChevronDown className={cn('h-4 w-4 transition-transform', menu && 'rotate-180')} strokeWidth={1.75} aria-hidden />
        </button>
        {menu && (
          <div id="services-menu" className="absolute left-0 top-12 z-40 w-[640px] rounded-sheet bg-surface p-3 shadow-modal">
            <ul className="grid grid-cols-2 gap-1">
              {categories.map((c) => (
                <li key={c.slug}>
                  <Link
                    href={`/services/${c.slug}`}
                    onClick={() => analytics.capture('megamenu_item_clicked', { category: c.slug })}
                    className="flex items-start gap-3 rounded-button p-2.5 hover:bg-foreground/5"
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-button bg-primary-soft text-primary">
                      <CategoryIcon icon={c.icon} className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[14px] font-semibold text-foreground">{pickI18n(c.name, locale)}</span>
                      {c.description && <span className="t-footnote line-clamp-1 text-foreground-secondary">{pickI18n(c.description, locale)}</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="hairline-t mt-2 flex items-center justify-between px-2 pt-3">
              <Link href="/services" className="t-callout font-semibold text-primary">{t('all_services')}</Link>
              <Link href="/partner/onboarding" className="t-subhead text-foreground-secondary hover:text-foreground">{t('for_providers')}</Link>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-1 justify-end md:justify-center">
        <button
          type="button"
          onClick={() => { setSearch(true); analytics.capture('command_search_opened', { via: 'public_header' }) }}
          className="hidden h-9 w-full max-w-sm items-center gap-2 rounded-input bg-sunken px-3 text-left text-[14px] text-foreground-tertiary lg:flex"
        >
          <Search className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          <span className="truncate">{t('search')}</span>
        </button>
        <button type="button" onClick={() => setSearch(true)} aria-label={t('search')} className="inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground-secondary hover:bg-foreground/5 lg:hidden">
          <Search className="h-5 w-5" strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      <Link
        href="/app/rfq/new"
        onClick={() => analytics.capture('post_requirement_clicked', { surface: 'public_header' })}
        className="hidden h-10 shrink-0 items-center rounded-button bg-primary px-4 text-[14px] font-semibold text-primary-foreground hover:bg-primary-strong sm:inline-flex"
      >
        {t('post_requirement')}
      </Link>

      <button type="button" onClick={() => setSheet(true)} aria-label={t('menu')} className="inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground md:hidden">
        <Menu className="h-5 w-5" strokeWidth={1.75} aria-hidden />
      </button>

      {sheet && <Sheet open={sheet} onClose={() => setSheet(false)} title={t('menu')} detent="large">
        <div className="space-y-4">
          <Link href="/app/rfq/new" className="flex h-12 items-center justify-center rounded-button bg-primary font-semibold text-primary-foreground">{t('post_requirement')}</Link>
          <ul className="grouped">
            {categories.map((c) => (
              <li key={c.slug}>
                <Link href={`/services/${c.slug}`} className="grouped-row flex items-center gap-3 px-4 text-[15px]">
                  <CategoryIcon icon={c.icon} className="h-5 w-5 text-primary" />
                  {pickI18n(c.name, locale)}
                </Link>
              </li>
            ))}
          </ul>
          <ul className="grouped">
            <li><Link href="/services" className="grouped-row flex items-center px-4 text-[15px] text-primary">{t('all_services')}</Link></li>
            <li><Link href="/partner/onboarding" className="grouped-row flex items-center px-4 text-[15px]">{t('for_providers')}</Link></li>
          </ul>
        </div>
      </Sheet>}
      {/* Mounted once opened (then kept, so ⌘K keeps working and the sheet can animate out). */}
      {searchMounted && <CommandSearch open={search} onOpenChange={setSearch} />}
    </>
  )
}
