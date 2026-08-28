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
  /** Headline professional credential KIND (e.g. 'icai'), never the number. */
  headlineCredential: string | null
}

export interface SearchResponse {
  /** false = network/server failure — show ErrorState + retry, NOT an empty state. */
  ok: boolean
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
  try {
    const res = await fetch(`${API_URL}/api/v1/catalog/search?${qs.toString()}`)
    if (!res.ok) return { ok: false, results: [], total: 0, nextOffset: null }
    return { ok: true, ...(await res.json()) }
  } catch {
    // Airplane mode / DNS failure — distinguishable from a true empty catalog.
    return { ok: false, results: [], total: 0, nextOffset: null }
  }
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
export async function fetchMyOrders(role: 'msme' | 'provider' = 'msme'): Promise<{ ok: boolean; orders: OrderListItem[] }> {
  try {
    const res = await fetch(`${API_URL}/api/v1/orders?role=${role}`, { headers: await authHeaders() })
    if (!res.ok) return { ok: false, orders: [] }
    const d = await res.json().catch(() => ({}))
    return { ok: true, orders: d.orders ?? [] }
  } catch {
    return { ok: false, orders: [] }
  }
}

// ── RFQ (Phase 5) — same /api/v1 the web uses, Bearer-authed ───────────────────

export async function createRfq(body: {
  category_slug: string
  title: string
  details: Record<string, unknown>
  budget_min_paise?: number
  budget_max_paise?: number
  needed_by?: string
  /** Phase 8b — transcript + parse when the RFQ began as voice. */
  voice_meta?: Record<string, unknown>
}) {
  const res = await fetch(`${API_URL}/api/v1/rfq`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ ...body, attachments: [] }),
  })
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) }
}

/** Phase 8b — voice → structured RFQ prefill. Parses only; never creates an
 *  RFQ. Content-Type is left to fetch so RN sets the multipart boundary. */
export async function voiceParse(fileUri: string, mimeType: string, durationMs: number) {
  const form = new FormData()
  const name = mimeType.includes('wav')
    ? 'recording.wav'
    : mimeType.includes('aac')
      ? 'recording.aac'
      : 'recording.m4a'
  form.append('audio', { uri: fileUri, name, type: mimeType } as unknown as Blob)
  form.append('duration_ms', String(Math.round(durationMs)))
  const res = await fetch(`${API_URL}/api/v1/rfq/voice-parse`, {
    method: 'POST',
    headers: await authHeaders(),
    body: form,
  })
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) }
}

export async function fetchMyRfqs(): Promise<{ ok: boolean; rfqs: unknown[] }> {
  try {
    const res = await fetch(`${API_URL}/api/v1/rfq/mine`, { headers: await authHeaders() })
    if (!res.ok) return { ok: false, rfqs: [] }
    return { ok: true, rfqs: (await res.json()).rfqs ?? [] }
  } catch {
    return { ok: false, rfqs: [] }
  }
}

export async function fetchRfq(rfqId: string) {
  const res = await fetch(`${API_URL}/api/v1/rfq/${rfqId}`, { headers: await authHeaders() })
  if (!res.ok) return null
  return res.json()
}

export async function fetchMatchedRfqs() {
  const res = await fetch(`${API_URL}/api/v1/rfq/matched`, { headers: await authHeaders() })
  if (!res.ok) return []
  return (await res.json()).rfqs ?? []
}

export async function submitQuote(
  rfqId: string,
  body: {
    price_paise: number
    delivery_days: number
    scope: string
    message?: string
    // Phase 4b — optional terms; omit = "not stated"
    gst_included?: boolean
    transport_included?: boolean
    valid_until?: string
    advance_percent?: number
  },
) {
  const res = await fetch(`${API_URL}/api/v1/rfq/${rfqId}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  })
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) }
}

export async function acceptQuote(quoteId: string) {
  const co = await fetch(`${API_URL}/api/v1/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ quoteId, idempotencyKey: cryptoRandomUUID() }),
  })
  const cod = await co.json().catch(() => ({}))
  if (!co.ok) return { ok: false, data: cod }
  if (cod.simulated) {
    const sim = await fetch(`${API_URL}/api/v1/checkout/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ checkoutSessionId: cod.checkoutSessionId }),
    })
    return { ok: sim.ok, data: await sim.json().catch(() => ({})) }
  }
  return { ok: true, data: cod }
}

export async function fetchQuoteMessages(quoteId: string) {
  const res = await fetch(`${API_URL}/api/v1/quotes/${quoteId}/messages`, { headers: await authHeaders() })
  if (!res.ok) return []
  return (await res.json()).messages ?? []
}

export async function sendQuoteMessage(quoteId: string, body: string) {
  const res = await fetch(`${API_URL}/api/v1/quotes/${quoteId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ body }),
  })
  return res.ok ? res.json() : null
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

// ── Notifications (Phase 6) — Bearer-authed; RLS scopes to the user ────────────

export interface NotificationItem {
  id: string
  kind: string
  title_i18n: { en: string; hi: string }
  body_i18n: { en: string; hi: string }
  link: string | null
  read_at: string | null
  created_at: string
}

export async function fetchNotifications(): Promise<{ ok: boolean; notifications: NotificationItem[]; unread: number }> {
  try {
    const res = await fetch(`${API_URL}/api/v1/notifications`, { headers: await authHeaders() })
    if (!res.ok) return { ok: false, notifications: [], unread: 0 }
    return { ok: true, ...(await res.json()) }
  } catch {
    return { ok: false, notifications: [], unread: 0 }
  }
}

export async function fetchUnreadCount(): Promise<number> {
  const res = await fetch(`${API_URL}/api/v1/notifications?unread=1`, { headers: await authHeaders() })
  if (!res.ok) return 0
  return (await res.json()).unread ?? 0
}

export async function markNotificationRead(opts: { id?: string; all?: boolean }) {
  const res = await fetch(`${API_URL}/api/v1/notifications/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(opts),
  })
  return res.ok
}

// ── Reviews (Phase 6) ──────────────────────────────────────────────────────────

export async function fetchOrderReview(orderId: string) {
  const res = await fetch(`${API_URL}/api/v1/orders/${orderId}/review`, { headers: await authHeaders() })
  if (!res.ok) return { review: null, canReview: false, isProvider: false }
  return res.json()
}

export async function submitReview(orderId: string, rating: number, text?: string) {
  const res = await fetch(`${API_URL}/api/v1/orders/${orderId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ rating, ...(text ? { text } : {}) }),
  })
  return { ok: res.ok, data: await res.json().catch(() => ({})) }
}

export async function replyReview(reviewId: string, reply: string) {
  const res = await fetch(`${API_URL}/api/v1/reviews/${reviewId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ reply }),
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
