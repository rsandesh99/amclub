/**
 * Shared catalog DTOs. These are the shapes the search RPC and query helpers
 * return and that ProviderCard / PackageCard / PriceBlock consume.
 */

export type Locale = 'en' | 'hi'

export interface I18nText {
  en: string
  hi?: string
}

export type SortOption = 'rating' | 'price_asc' | 'price_desc' | 'newest'

export interface SearchFilters {
  query?: string
  categorySlug?: string
  state?: string
  minPrice?: number // paise
  maxPrice?: number // paise
  minRating?: number
  language?: string
  verifiedOnly?: boolean
  sort?: SortOption
  limit?: number
  offset?: number
}

/** One search/listing row — a package joined with its provider + category. */
export interface CatalogResult {
  packageId: string
  packageSlug: string
  titleI18n: I18nText
  pricePaise: number
  discountBps: number
  memberExtraDiscountBps: number
  deliveryDays: number
  revisionCount: number
  categoryId: string
  categorySlug: string
  categoryNameI18n: I18nText
  providerId: string
  providerSlug: string
  displayName: string
  logoUrl: string | null
  state: string
  city: string | null
  languages: string[]
  avgRating: number
  reviewCount: number
  completedOrders: number
  medianResponseMinutes: number | null
  topRated: boolean
  verified: boolean
  /** Headline professional credential KIND (e.g. 'icai'), never the number. */
  headlineCredential: string | null
}

export interface SearchResponse {
  results: CatalogResult[]
  total: number
  nextOffset: number | null
}

export interface CategoryRow {
  id: string
  slug: string
  nameI18n: I18nText
  descriptionI18n: I18nText | null
  icon: string | null
  sortOrder: number | null
}

/** Verification badge — kind + status only, never the underlying value. */
export interface VerificationBadge {
  kind: string
  status: string
}

export interface ProviderDetail {
  id: string
  displayName: string
  slug: string
  about: string | null
  logoUrl: string | null
  state: string
  city: string | null
  languages: string[]
  avgRating: number
  reviewCount: number
  completedOrders: number
  medianResponseMinutes: number | null
  topRated: boolean
  createdAt: string
  categories: { slug: string; nameI18n: I18nText }[]
  badges: VerificationBadge[]
}

export interface PackageDetail {
  id: string
  slug: string
  titleI18n: I18nText
  scopeIncluded: string[]
  scopeExcluded: string[]
  deliverables: string[]
  requirementsTemplate: unknown
  pricePaise: number
  discountBps: number
  memberExtraDiscountBps: number
  deliveryDays: number
  revisionCount: number
  faqs: { q: string; a: string }[]
  categorySlug: string
  categoryNameI18n: I18nText
}

export interface ReviewRow {
  id: string
  rating: number
  body: string | null
  authorName: string | null
  providerReply: string | null
  createdAt: string
}
