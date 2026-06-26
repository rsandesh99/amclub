/** Thin client over the web /api/v1 catalog endpoints. Shares the same search
 *  API as web (§ Phase 3). Auth'd calls attach the Supabase access token. */
import Constants from 'expo-constants'
import { supabase } from './supabase'

const API_URL =
  (Constants.expoConfig?.extra?.['apiUrl'] as string | undefined) ??
  process.env['EXPO_PUBLIC_API_URL'] ??
  'http://localhost:3000'

export interface CatalogResult {
  packageId: string
  packageSlug: string
  titleI18n: { en: string; hi?: string }
  pricePaise: number
  discountBps: number
  memberExtraDiscountBps: number
  deliveryDays: number
  revisionCount: number
  categorySlug: string
  categoryNameI18n: { en: string; hi?: string }
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
}

export interface SearchResponse {
  results: CatalogResult[]
  total: number
  nextOffset: number | null
}

export interface SearchParams {
  query?: string
  category?: string
  state?: string
  minPrice?: number
  maxPrice?: number
  minRating?: number
  language?: string
  verifiedOnly?: boolean
  sort?: 'rating' | 'price_asc' | 'price_desc' | 'newest'
  limit?: number
  offset?: number
}

export async function searchCatalog(params: SearchParams): Promise<SearchResponse> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
  }
  const res = await fetch(`${API_URL}/api/v1/catalog/search?${qs.toString()}`)
  if (!res.ok) return { results: [], total: 0, nextOffset: null }
  return res.json()
}

export async function fetchProvider(slug: string) {
  const res = await fetch(`${API_URL}/api/v1/catalog/provider/${slug}`)
  if (!res.ok) return null
  return res.json()
}

export async function fetchPackage(providerSlug: string, packageSlug: string) {
  const res = await fetch(`${API_URL}/api/v1/catalog/package/${providerSlug}/${packageSlug}`)
  if (!res.ok) return null
  return res.json()
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function getSavedProviderIds(): Promise<string[]> {
  const res = await fetch(`${API_URL}/api/v1/saved`, { headers: await authHeaders() })
  if (!res.ok) return []
  const d = await res.json()
  return d.providerIds ?? []
}

export async function toggleSaved(providerId: string, action: 'save' | 'unsave') {
  const res = await fetch(`${API_URL}/api/v1/saved`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ providerId, action }),
  })
  return res.ok
}

// ── Checkout + orders (shared /api/v1; Bearer-authed) ──────────────────────────

export async function createCheckout(packageId: string) {
  const res = await fetch(`${API_URL}/api/v1/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ packageId, idempotencyKey: cryptoRandomUUID() }),
  })
  return { ok: res.ok, data: await res.json().catch(() => ({})) }
}

/** Simulation only — completes the captured-payment path when real keys absent. */
export async function simulatePay(checkoutSessionId: string) {
  const res = await fetch(`${API_URL}/api/v1/checkout/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ checkoutSessionId }),
  })
  return { ok: res.ok, data: await res.json().catch(() => ({})) }
}

export interface OrderListItem {
  id: string
  order_number: string
  title: string
  status: string
  total_paise: number
  provider_earning_paise: number
  created_at: string
}

/** The signed-in buyer's orders (newest first). Bearer-authed. */
export async function fetchMyOrders(role: 'msme' | 'provider' = 'msme'): Promise<OrderListItem[]> {
  const res = await fetch(`${API_URL}/api/v1/orders?role=${role}`, { headers: await authHeaders() })
  if (!res.ok) return []
  const d = await res.json().catch(() => ({}))
  return d.orders ?? []
}

export async function fetchOrder(orderId: string) {
  const res = await fetch(`${API_URL}/api/v1/orders/${orderId}`, { headers: await authHeaders() })
  if (!res.ok) return null
  return res.json()
}

export async function transitionOrder(orderId: string, action: string) {
  const res = await fetch(`${API_URL}/api/v1/orders/${orderId}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ action }),
  })
  return { ok: res.ok, data: await res.json().catch(() => ({})) }
}

function cryptoRandomUUID(): string {
  // RN lacks crypto.randomUUID in some runtimes — RFC4122 v4 fallback.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export { API_URL }
