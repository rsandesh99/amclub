'use client'

import { BadgeCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { usePathname, useRouter } from '@/i18n/navigation'
import { useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'
import { INDIAN_STATES } from '@/lib/constants/india'

const PRICE_BUCKETS: Record<string, { min?: number; max?: number }> = {
  any: {},
  under2k: { max: 200000 },
  '2kto5k': { min: 200000, max: 500000 },
  '5kto10k': { min: 500000, max: 1000000 },
  over10k: { min: 1000000 },
}

const LANGS = ['en', 'hi', 'te', 'ta', 'mr']

export function ListingControls() {
  const t = useTranslations('catalog')
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function update(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k)
      else next.set(k, v)
    }
    next.delete('offset') // reset pagination on any filter change
    const qs = next.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  const currentBucket =
    Object.entries(PRICE_BUCKETS).find(([k]) => k === params.get('price'))?.[0] ?? 'any'
  const verified = params.get('verifiedOnly') === 'true'

  // Filter selects share the design-system `.field-select` (consistent height,
  // border, focus ring, token-coloured chevron) — never raw browser defaults.
  const selectCls = 'field-select w-auto min-w-[7.5rem]'

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Sort */}
      <select
        className={selectCls}
        value={params.get('sort') ?? 'rating'}
        onChange={(e) => update({ sort: e.target.value })}
        aria-label={t('sort_by')}
      >
        <option value="rating">{t('sort_rating')}</option>
        <option value="price_asc">{t('sort_price_asc')}</option>
        <option value="price_desc">{t('sort_price_desc')}</option>
        <option value="newest">{t('sort_newest')}</option>
      </select>

      {/* State */}
      <select
        className={selectCls}
        value={params.get('state') ?? ''}
        onChange={(e) => update({ state: e.target.value || null })}
        aria-label={t('filter_state')}
      >
        <option value="">{t('all_states')}</option>
        {/* E0 / U5 — every state and UT by name (was 10 raw codes). */}
        {INDIAN_STATES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>

      {/* Price */}
      <select
        className={selectCls}
        value={currentBucket}
        onChange={(e) => {
          const bucket = PRICE_BUCKETS[e.target.value] ?? {}
          update({
            price: e.target.value === 'any' ? null : e.target.value,
            minPrice: bucket.min ? String(bucket.min) : null,
            maxPrice: bucket.max ? String(bucket.max) : null,
          })
        }}
        aria-label={t('filter_price')}
      >
        <option value="any">{t('any_price')}</option>
        <option value="under2k">{t('price_under2k')}</option>
        <option value="2kto5k">{t('price_2kto5k')}</option>
        <option value="5kto10k">{t('price_5kto10k')}</option>
        <option value="over10k">{t('price_over10k')}</option>
      </select>

      {/* Rating */}
      <select
        className={selectCls}
        value={params.get('minRating') ?? ''}
        onChange={(e) => update({ minRating: e.target.value || null })}
        aria-label={t('filter_rating')}
      >
        <option value="">{t('any_rating')}</option>
        <option value="4.5">{t('rating_45')}</option>
        <option value="4">{t('rating_4')}</option>
        <option value="3.5">{t('rating_35')}</option>
      </select>

      {/* Language */}
      <select
        className={selectCls}
        value={params.get('language') ?? ''}
        onChange={(e) => update({ language: e.target.value || null })}
        aria-label={t('filter_language')}
      >
        <option value="">{t('any_language')}</option>
        {LANGS.map((l) => (
          <option key={l} value={l}>
            {t(`lang_${l}` as 'lang_en')}
          </option>
        ))}
      </select>

      {/* Verified-only — pill toggle, same height as the selects */}
      <button
        type="button"
        onClick={() => update({ verifiedOnly: verified ? null : 'true' })}
        aria-pressed={verified}
        className={cn(
          'chip-toggle',
          verified
            ? 'border-trust bg-trust/10 text-trust'
            : 'border-border bg-surface text-foreground-secondary hover:border-trust/40 hover:text-foreground',
        )}
      >
        <BadgeCheck className="h-4 w-4" aria-hidden />
        {t('verified_only')}
      </button>
    </div>
  )
}
