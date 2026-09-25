import { Link } from '@/i18n/navigation'
import { getTranslations } from 'next-intl/server'
import { formatINR } from '@/lib/format'
import type { ProductSort } from '@/lib/mart/queries'

/** Price bands on the min_qty=1 tier price (paise). */
export const PRICE_BANDS: { key: string; min?: number; max?: number }[] = [
  { key: 'u100', max: 10_000 },
  { key: '100-1000', min: 10_000, max: 100_000 },
  { key: 'o1000', min: 100_000 },
]

export interface FilterState {
  sort: ProductSort
  brand?: string
  band?: string
}

function withParams(base: string, current: Record<string, string | undefined>, patch: Record<string, string | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) p.set(k, v)
  const qs = p.toString()
  return qs ? `${base}?${qs}` : base
}

/**
 * Server-rendered filter/sort chips — every chip is a link, so filtering
 * works without JS and every combination is an edge-cacheable URL.
 */
export async function FilterBar({ base, current, brands }: { base: string; current: Record<string, string | undefined>; brands: string[] }) {
  const t = await getTranslations('mart')
  const chip = (active: boolean) =>
    `chip-toggle h-10 shrink-0 text-meta ${active ? 'border-emerald bg-emerald text-ivory' : 'border-brass/50 bg-ivory text-emerald-ink'}`
  const sort = (current['sort'] as ProductSort | undefined) ?? 'newest'
  const bandLabel = (b: { key: string; min?: number; max?: number }) =>
    b.min === undefined ? t('under', { amount: formatINR(b.max!) }) : b.max === undefined ? t('over', { amount: formatINR(b.min) }) : `${formatINR(b.min)}–${formatINR(b.max)}`
  return (
    <div className="mt-3 space-y-2">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label={t('sort')}>
        {(['newest', 'price_asc', 'price_desc'] as const).map((s) => (
          <Link key={s} href={withParams(base, current, { sort: s === 'newest' ? undefined : s }) as '/services'} className={chip(sort === s)} aria-pressed={sort === s}>
            {t(`sort_${s}` as 'sort_newest')}
          </Link>
        ))}
        <span className="mx-1 w-px shrink-0 self-stretch bg-brass/40" aria-hidden="true" />
        <Link href={withParams(base, current, { band: undefined }) as '/services'} className={chip(!current['band'])} aria-pressed={!current['band']}>{t('any_price')}</Link>
        {PRICE_BANDS.map((b) => (
          <Link key={b.key} href={withParams(base, current, { band: b.key }) as '/services'} className={chip(current['band'] === b.key)} aria-pressed={current['band'] === b.key}>{bandLabel(b)}</Link>
        ))}
      </div>
      {brands.length > 0 && (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label={t('brand')}>
          <Link href={withParams(base, current, { brand: undefined }) as '/services'} className={chip(!current['brand'])} aria-pressed={!current['brand']}>{t('all_brands')}</Link>
          {brands.map((b) => (
            <Link key={b} href={withParams(base, current, { brand: b }) as '/services'} className={chip(current['brand'] === b)} aria-pressed={current['brand'] === b}>{b}</Link>
          ))}
        </div>
      )}
    </div>
  )
}
