'use client'

import { useCallback, useState } from 'react'
import dynamic from 'next/dynamic'
import { useLocale, useTranslations } from 'next-intl'
import { BadgeCheck, Clock, IndianRupee, Star, Languages, SlidersHorizontal, LayoutGrid, List, Check } from 'lucide-react'
import { activeFilterCountV2, SEARCH_SORTS_V2, type SearchFacets, type SearchView } from '@amclub/shared'
import { cn } from '@/lib/utils'
import { Picker } from '@/components/ui-v3/Picker'
import { SegmentedControl } from '@/components/ui-v3/SegmentedControl'
import { filterSections, type FilterSection } from './filter-defs'
import { useSearchNav } from './useSearchNav'

// The sheet (and its motion code) loads on first open, not with the results.
const Sheet = dynamic(() => import('@/components/ui-v3/Sheet').then((m) => m.Sheet), { ssr: false })

const chipCls = (on: boolean) =>
  cn(
    'inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-chip border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
    on ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border bg-surface text-foreground-secondary hover:border-primary/40 hover:text-foreground',
  )

const Count = ({ n }: { n: number | undefined }) =>
  n === undefined ? null : <span className="tabular-nums text-foreground-tertiary">{n}</span>

/** One section, drawn for the sheet (chips / segments) or the desktop rail (a list with counts). */
function SectionView({ section, variant, onSet }: { section: FilterSection; variant: 'sheet' | 'rail'; onSet: (v: string | null) => void }) {
  const t = useTranslations('filters_v3')
  if (section.kind === 'picker') {
    return (
      <Picker
        label={section.title}
        placeholder={t('any')}
        value={section.value}
        allowClear
        clearLabel={t('any')}
        recentKey={`filter_${section.key}`}
        options={section.options.map((o) => ({ value: o.value, label: o.count !== undefined ? `${o.label} (${o.count})` : o.label, keywords: o.value }))}
        onChange={onSet}
      />
    )
  }
  if (variant === 'sheet' && section.kind === 'segments') {
    return (
      <SegmentedControl<string>
        ariaLabel={section.title}
        size="sm"
        options={[{ value: 'any', label: t('any') }, ...section.options.map((o) => ({ value: o.value, label: o.label }))]}
        value={section.value ?? 'any'}
        onChange={(v) => onSet(v === 'any' ? null : v)}
      />
    )
  }
  if (variant === 'rail') {
    return (
      <ul className="space-y-0.5">
        {section.options.map((o) => {
          const on = section.value === o.value
          return (
            <li key={o.value}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onSet(on ? null : o.value)}
                disabled={!on && o.count === 0}
                className={cn('flex min-h-[32px] w-full items-center gap-2 rounded-button px-2 text-left text-sm hover:bg-sunken disabled:opacity-40', on && 'font-medium text-primary')}
              >
                <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', on ? 'border-primary bg-primary text-white' : 'border-border')}>
                  {on && <Check className="h-3 w-3" aria-hidden />}
                </span>
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                <Count n={o.count} />
              </button>
            </li>
          )
        })}
      </ul>
    )
  }
  return (
    <div className="flex flex-wrap gap-2">
      {/* Single-choice chips start with "Any" (clears the filter), like the segmented sections. */}
      {section.kind === 'chips' && (
        <button type="button" aria-pressed={section.value === null} onClick={() => onSet(null)} className={chipCls(section.value === null)}>
          {t('any')}
        </button>
      )}
      {section.options.map((o) => {
        const on = section.value === o.value
        return (
          <button key={o.value} type="button" aria-pressed={on} onClick={() => onSet(on ? null : o.value)} className={chipCls(on)}>
            {o.label}
            <Count n={o.count} />
          </button>
        )
      })}
    </div>
  )
}

function useSections(facets: SearchFacets | null, fixedCategory?: string, fixedService?: string) {
  const t = useTranslations()
  const locale = useLocale()
  const nav = useSearchNav()
  const sections = filterSections((k, v) => t(k as never, v as never), locale, nav.current, facets, fixedCategory)
    .filter((sec) => !(fixedService && sec.key === 'service'))
    // A section with nothing to choose (e.g. no provider here holds any credential) is not drawn.
    .filter((sec) => sec.options.length > 0)
  return { nav, sections }
}

/**
 * FR-2.2 phones / tablets: ≤ 5 chips (Verified · ≤ 7 days · Price · 4★+ ·
 * Language) + "More" → the full filter sheet. Visible before a query.
 */
export function FilterChipBar({ facets, fixedCategory, fixedService, className }: { facets: SearchFacets | null; fixedCategory?: string; fixedService?: string; className?: string }) {
  const t = useTranslations('filters_v3')
  const { nav, sections } = useSections(facets, fixedCategory, fixedService)
  const [open, setOpen] = useState(false)
  // The section a chip opened the sheet at (Price → price, Language → language; More → the top).
  const [focus, setFocus] = useState<string | null>(null)
  const openAt = (key: string | null) => { setFocus(key); setOpen(true) }
  // Callback ref, stable: runs once when that section mounts in the sheet and scrolls the sheet body to it.
  const scrollIntoSheet = useCallback((el: HTMLElement | null) => {
    const box = el?.closest<HTMLElement>('.overflow-y-auto')
    if (el && box) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top
  }, [])
  const s = nav.current
  const active = activeFilterCountV2(s)
  const total = facets?.total?.['all']

  return (
    <>
      <div className={cn('-mx-4 flex gap-2 overflow-x-auto px-4 pb-1', className)} data-testid="filter-chips">
        <button type="button" aria-pressed={!!s.verifiedOnly} onClick={() => nav.setRaw('verifiedOnly', s.verifiedOnly ? null : 'true')} className={chipCls(!!s.verifiedOnly)}>
          <BadgeCheck className="h-4 w-4" aria-hidden /> {t('chip_verified')}
        </button>
        <button type="button" aria-pressed={s.deliveryMaxDays === 7} onClick={() => nav.setRaw('deliveryMaxDays', s.deliveryMaxDays === 7 ? null : '7')} className={chipCls(s.deliveryMaxDays === 7)}>
          <Clock className="h-4 w-4" aria-hidden /> {t('within_days', { n: 7 })}
        </button>
        <button type="button" aria-pressed={!!s.price} onClick={() => openAt('price')} className={chipCls(!!s.price)}>
          <IndianRupee className="h-4 w-4" aria-hidden /> {t('chip_price')}
        </button>
        <button type="button" aria-pressed={s.minRating === 4} onClick={() => nav.setRaw('minRating', s.minRating === 4 ? null : '4')} className={chipCls(s.minRating === 4)}>
          <Star className="h-4 w-4" aria-hidden /> {t('rating_plus', { n: 4 })}
        </button>
        <button type="button" aria-pressed={!!s.language} onClick={() => openAt('language')} className={chipCls(!!s.language)}>
          <Languages className="h-4 w-4" aria-hidden /> {t('chip_language')}
        </button>
        <button type="button" onClick={() => openAt(null)} className={chipCls(active > 0)} data-testid="filter-more">
          <SlidersHorizontal className="h-4 w-4" aria-hidden /> {active > 0 ? t('more_count', { n: active }) : t('chip_more')}
        </button>
      </div>
      {open && (
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={t('filters')}
        detent="large"
        footer={
          <div className="flex items-center justify-between gap-3">
            <button type="button" className="min-h-[44px] px-2 text-sm font-medium text-primary" onClick={nav.clearFilters}>{t('clear_all')}</button>
            <button type="button" className="min-h-[44px] rounded-button bg-primary px-5 text-sm font-semibold text-white" onClick={() => setOpen(false)}>
              {total !== undefined ? t('show_results', { count: total }) : t('done')}
            </button>
          </div>
        }
      >
        <div className="space-y-6">
          {sections.map((sec) => (
            <section key={sec.key} ref={sec.key === focus ? scrollIntoSheet : undefined} data-filter-section={sec.key}>
              <h3 className="t-subheadline mb-2 font-semibold">{sec.title}</h3>
              <SectionView section={sec} variant="sheet" onSet={(v) => nav.setRaw(sec.key, v)} />
            </section>
          ))}
        </div>
      </Sheet>
      )}
    </>
  )
}

/** FR-2.2 desktop ≥ 1280: a collapsible facet rail with counts. */
export function FacetRail({ facets, fixedCategory, fixedService }: { facets: SearchFacets | null; fixedCategory?: string; fixedService?: string }) {
  const t = useTranslations('filters_v3')
  const { nav, sections } = useSections(facets, fixedCategory, fixedService)
  return (
    <nav aria-label={t('filters')} className="space-y-4" data-testid="facet-rail">
      <div className="flex items-center justify-between">
        <h2 className="t-headline">{t('filters')}</h2>
        {activeFilterCountV2(nav.current) > 0 && (
          <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={nav.clearFilters}>{t('clear_all')}</button>
        )}
      </div>
      {sections.map((sec) => (
        <details key={sec.key} open={sec.kind !== 'segments' || sec.value !== null || sec.key === 'deliveryMaxDays'} className="border-t border-separator pt-3">
          <summary className="cursor-pointer text-sm font-semibold">{sec.title}</summary>
          <div className="mt-2">
            <SectionView section={sec} variant="rail" onSet={(v) => nav.setRaw(sec.key, v)} />
          </div>
        </details>
      ))}
    </nav>
  )
}

/** Sort (6 options → a Picker, per the v3 control rules). */
export function SortControl() {
  const t = useTranslations('filters_v3')
  const nav = useSearchNav()
  return (
    <Picker
      className="w-44"
      label={t('sort')}
      value={nav.current.sort ?? 'best'}
      options={SEARCH_SORTS_V2.map((s) => ({ value: s, label: t(`sort_${s}`) }))}
      onChange={(v) => nav.setRaw('sort', v === 'best' ? null : v)}
    />
  )
}

/** FR-2.4 grid / list, remembered on this device for the next visit. */
export function ViewToggle({ view }: { view: SearchView }) {
  const t = useTranslations('filters_v3')
  const nav = useSearchNav()
  return (
    <SegmentedControl<SearchView>
      size="sm"
      ariaLabel={t('view')}
      options={[
        { value: 'grid', label: <LayoutGrid className="h-4 w-4" aria-hidden />, ariaLabel: t('view_grid') },
        { value: 'list', label: <List className="h-4 w-4" aria-hidden />, ariaLabel: t('view_list') },
      ]}
      value={view}
      onChange={(v) => {
        document.cookie = `amc_search_view=${v}; path=/; max-age=31536000; samesite=lax`
        nav.setRaw('view', v)
      }}
    />
  )
}
