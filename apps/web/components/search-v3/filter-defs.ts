'use client'

import {
  CATEGORY_LIST,
  DELIVERY_CHOICES,
  INDIAN_STATES,
  PRICE_BAND_KEYS,
  RATING_CHOICES,
  RESPONSE_CHOICES,
  SEARCH_CREDENTIALS,
  SPECIALIZATIONS,
  type CategorySlug,
  type SearchFacets,
  type SearchV2,
} from '@amclub/shared'
import { pickI18n } from '@/lib/format'

export interface FilterOption {
  value: string
  label: string
  count?: number | undefined
}
export interface FilterSection {
  key: keyof SearchV2
  title: string
  kind: 'chips' | 'segments' | 'picker' | 'toggle'
  options: FilterOption[]
  /** Current value in URL form, or null. */
  value: string | null
}

type T = (key: string, values?: Record<string, string | number>) => string

export const SEARCH_LANGS = ['en', 'hi', 'te', 'ta', 'mr'] as const

/**
 * The filter sections, in order, with facet counts where the facet RPC gave
 * them. `fixedCategory` (a category page) hides the category section and
 * scopes the services.
 */
export function filterSections(t: T, locale: string, s: SearchV2, facets: SearchFacets | null, fixedCategory?: string): FilterSection[] {
  const count = (f: keyof SearchFacets, v: string) => facets?.[f]?.[v] ?? (facets ? 0 : undefined)
  const category = (fixedCategory ?? s.category) as CategorySlug | undefined
  const sections: FilterSection[] = []
  if (!fixedCategory) {
    sections.push({
      key: 'category', title: t('filters_v3.sec_category'), kind: 'chips', value: s.category ?? null,
      options: CATEGORY_LIST.map((c) => ({ value: c.slug, label: pickI18n(c.name_i18n, locale), count: count('category', c.slug) })),
    })
  }
  if (category && SPECIALIZATIONS[category]) {
    sections.push({
      key: 'service', title: t('filters_v3.sec_service'), kind: 'chips', value: s.service ?? null,
      options: SPECIALIZATIONS[category].map((v) => ({ value: v, label: t(`services.${v}`), count: count('service', v) })),
    })
  }
  sections.push(
    {
      key: 'state', title: t('filters_v3.sec_state'), kind: 'picker', value: s.state ?? null,
      options: INDIAN_STATES.map((st) => ({ value: st.value, label: st.label, count: count('state', st.value) })),
    },
    {
      key: 'credential', title: t('filters_v3.sec_credential'), kind: 'chips', value: s.credential ?? null,
      options: SEARCH_CREDENTIALS.map((k) => ({ value: k, label: t(`catalog.badge_${k}`), count: count('credential', k) }))
        .filter((o) => o.count === undefined || o.count > 0 || o.value === s.credential),
    },
    {
      key: 'deliveryMaxDays', title: t('filters_v3.sec_delivery'), kind: 'segments', value: s.deliveryMaxDays ? String(s.deliveryMaxDays) : null,
      options: DELIVERY_CHOICES.map((d) => ({ value: String(d), label: t('filters_v3.within_days', { n: d }), count: count('delivery', String(d)) })),
    },
    {
      key: 'responseMaxHours', title: t('filters_v3.sec_response'), kind: 'segments', value: s.responseMaxHours ? String(s.responseMaxHours) : null,
      options: RESPONSE_CHOICES.map((h) => ({ value: String(h), label: t('filters_v3.within_hours', { n: h }) })),
    },
    {
      key: 'price', title: t('filters_v3.sec_price'), kind: 'chips', value: s.price ?? null,
      options: PRICE_BAND_KEYS.map((b) => ({ value: b, label: t(`catalog.price_${b}`) })),
    },
    {
      key: 'minRating', title: t('filters_v3.sec_rating'), kind: 'segments', value: s.minRating !== undefined ? String(s.minRating) : null,
      options: RATING_CHOICES.map((r) => ({ value: String(r), label: t('filters_v3.rating_plus', { n: r }), count: count('rating', String(r)) })),
    },
    {
      key: 'language', title: t('filters_v3.sec_language'), kind: 'chips', value: s.language ?? null,
      options: SEARCH_LANGS.map((l) => ({ value: l, label: t(`catalog.lang_${l}`), count: count('language', l) })),
    },
    {
      key: 'verifiedOnly', title: t('filters_v3.sec_verified'), kind: 'toggle', value: s.verifiedOnly ? 'true' : null,
      options: [{ value: 'true', label: t('filters_v3.chip_verified'), count: count('verified', 'true') }],
    },
  )
  return sections
}
