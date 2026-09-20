/** Thin client over the web /api/v1 catalog endpoints. Shares the same search
 *  API as web (§ Phase 3). Auth'd calls attach the Supabase access token. */
import Constants from 'expo-constants'
import { supabase } from './supabase'
import type { ProfileMeResponse, QuoteExtractResponse } from '@amclub/shared'

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

/** AMC Mart M2 — goods_spec body (goodsRfqSpecSchema in @amclub/shared). */
export interface GoodsRfqSpecInput {
  item: string
  qty: number
  unit: string
  spec: { k: string; v: string }[]
  brand_preference?: string
  target_unit_price_paise?: number
  delivery: GoodsDelivery
  product_id?: string
}

/** AMC Mart M2 — goods terms on a quote; the server computes price_paise = qty × unit price. */
export interface GoodsQuoteTermsInput {
  unit_price_paise: number
  gst_rate_bps: number
  hsn_code: string
  product_id?: string
  qty?: number
}

export async function createRfq(body: {
  /** AMC Mart M2 — 'goods' carries a Mart category + spec; absent = services. */
  kind?: 'service' | 'goods'
  category_slug?: string
  mart_category_slug?: string
  goods_spec?: GoodsRfqSpecInput
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

/** S1.1 — server-authoritative flags for this user (quoteExtractEnabled, martEnabled). null on failure. */
export async function fetchMe(): Promise<Partial<ProfileMeResponse> | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/profile/me`, { headers: await authHeaders() })
    if (!res.ok) return null
    return (await res.json()) as Partial<ProfileMeResponse>
  } catch {
    return null
  }
}

/** S1.1 — free text → quote-form prefill (bounded model call; nothing is submitted). 404 while dark. */
export async function extractQuote(
  rfqId: string,
  body: { text: string; source: 'typed' | 'voice' },
): Promise<{ ok: true; status: number; data: QuoteExtractResponse } | { ok: false; status: number; data: { error?: string } }> {
  try {
    const res = await fetch(`${API_URL}/api/v1/rfq/${rfqId}/quote/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    return res.ok ? { ok: true, status: res.status, data: data as QuoteExtractResponse } : { ok: false, status: res.status, data }
  } catch {
    return { ok: false, status: 0, data: { error: 'network' } }
  }
}

/** S1.2 — deterministic compare results (+ pointers when the agent is on for this buyer). */
export async function fetchCompare(rfqId: string, locale: string): Promise<{ results: any[]; pointers: { pointers: { quote_id: string; lines: string[] }[] } | null } | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/rfq/${rfqId}/compare?locale=${encodeURIComponent(locale)}`, { headers: await authHeaders() })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

/** S1.2 — buyer declines one quote with a reason (+ optional private note). */
export async function declineQuote(rfqId: string, quoteId: string, body: { reason: string; note?: string }) {
  const res = await fetch(`${API_URL}/api/v1/rfq/${rfqId}/quote/${quoteId}/decline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  })
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) }
}

/** S1.3 — the RFQ's clarification thread for the caller (buyer or matched provider). */
export async function fetchClarifications(rfqId: string): Promise<{ clarifications: any[]; role: 'buyer' | 'provider' } | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/rfq/${rfqId}/clarifications`, { headers: await authHeaders() })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

/** S1.3 — a matched provider asks one question (≤ 3 open at a time; contact info masked server-side). */
export async function askClarification(rfqId: string, question: string) {
  const res = await fetch(`${API_URL}/api/v1/rfq/${rfqId}/clarifications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ question }),
  })
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) }
}

/** S1.3 — the buyer answers one question, once (visible to every matched provider). */
export async function answerClarification(rfqId: string, clarificationId: string, answer: string) {
  const res = await fetch(`${API_URL}/api/v1/rfq/${rfqId}/clarifications/${clarificationId}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ answer }),
  })
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) }
}

/** S1.3 — revise the provider's own submitted quote in place (every field restated; never an extraction_id). */
export async function reviseQuote(
  rfqId: string,
  body: {
    price_paise: number
    delivery_days: number
    scope: string
    message?: string
    gst_included?: boolean
    transport_included?: boolean
    valid_until?: string
    advance_percent?: number
    goods?: GoodsQuoteTermsInput
  },
) {
  const res = await fetch(`${API_URL}/api/v1/rfq/${rfqId}/quote`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  })
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) }
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
    /** AMC Mart M2 — required on a goods RFQ. */
    goods?: GoodsQuoteTermsInput
    /** S1.1 — the extraction the provider confirmed with this submit (omit = typed by hand). */
    extraction_id?: string
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

// ── AMC Mart (goods mode) — dark build; the server gates every route on the
// MART_ENABLED flag. Every money field below is server-computed paise: the
// client renders them and never derives totals, GST or ITC (review-blocking).

export interface MartCategory {
  slug: string
  nameI18n: { en: string; hi?: string; te?: string }
  bisBlocked: boolean
}

export interface MartTier {
  min_qty: number
  unit_price_paise: number
  unit_gst_paise: number
  unit_incl_gst_paise: number
  unit_after_itc_paise: number
}

export interface MartProduct {
  id: string
  name: string
  description: string | null
  categorySlug: string
  hsnCode: string
  gstRateBps: number
  unit: string
  images: string[]
  imageUrls: string[]
  minOrderQty: number
  seller: { id: string; displayName: string; slug: string; city: string | null; state: string }
  tiers: MartTier[]
  /** The min_qty=1 (list) tier, or the lowest tier — null when unpriced. */
  list: MartTier | null
}

export interface MartCategoriesResponse {
  ok: boolean
  categories: MartCategory[]
}

export async function fetchMartCategories(): Promise<MartCategoriesResponse> {
  try {
    const res = await fetch(`${API_URL}/api/v1/mart/categories`)
    if (!res.ok) return { ok: false, categories: [] }
    const d = await res.json().catch(() => ({}))
    return { ok: true, categories: d.categories ?? [] }
  } catch {
    return { ok: false, categories: [] }
  }
}

export interface MartSearchParams {
  category?: string
  query?: string
  limit?: number
  offset?: number
}

export interface MartSearchResponse {
  /** false = network/server failure — show ErrorState + retry, NOT an empty state. */
  ok: boolean
  products: MartProduct[]
  total: number
  nextOffset: number | null
}

export async function searchMartProducts(params: MartSearchParams): Promise<MartSearchResponse> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
  }
  try {
    const res = await fetch(`${API_URL}/api/v1/mart/products?${qs.toString()}`)
    if (!res.ok) return { ok: false, products: [], total: 0, nextOffset: null }
    const d = await res.json().catch(() => ({}))
    return { ok: true, products: d.products ?? [], total: d.total ?? 0, nextOffset: d.nextOffset ?? null }
  } catch {
    return { ok: false, products: [], total: 0, nextOffset: null }
  }
}

/** ok:true + product:null = 404 (delisted); ok:false = network/server failure. */
export async function fetchMartProduct(id: string): Promise<{ ok: boolean; product: MartProduct | null }> {
  try {
    const res = await fetch(`${API_URL}/api/v1/mart/products/${encodeURIComponent(id)}`)
    if (res.status === 404) return { ok: true, product: null }
    if (!res.ok) return { ok: false, product: null }
    const d = await res.json().catch(() => ({}))
    return { ok: true, product: d.product ?? null }
  } catch {
    return { ok: false, product: null }
  }
}

export interface GoodsDelivery {
  contact_name: string
  contact_phone: string
  address: string
  city: string
  /** Two-letter state code, e.g. "AP". */
  state: string
  pincode: string
  pickup: boolean
}

export type GoodsCheckoutErrorCode =
  | 'product_unavailable'
  | 'multiple_sellers'
  | 'below_min_qty'
  | 'category_blocked'
  | 'no_tier'

export interface GoodsCheckoutResponse {
  checkoutSessionId: string
  razorpayOrderId: string
  amountPaise: number
  simulated?: boolean
  idempotent?: boolean
  amounts?: { taxablePaise: number; gstPaise: number; totalPaise: number; afterItcPaise: number }
  lineItems?: unknown[]
  sellerName?: string
  deliveryDays?: number
}

export type GoodsCheckoutResult =
  | { ok: true; status: number; data: GoodsCheckoutResponse }
  | { ok: false; status: number; errorCode: GoodsCheckoutErrorCode | null; data: Record<string, unknown> }

/** POST /api/v1/mart/checkout — one seller per session; totals come back from
 *  the server. status 0 = network failure (never throws into the UI). */
export async function createGoodsCheckout(body: {
  items: { product_id: string; qty: number }[]
  delivery: GoodsDelivery
}): Promise<GoodsCheckoutResult> {
  try {
    const res = await fetch(`${API_URL}/api/v1/mart/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ ...body, idempotencyKey: cryptoRandomUUID() }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.ok) return { ok: true, status: res.status, data: data as unknown as GoodsCheckoutResponse }
    const err = data['error']
    const code = err && typeof err === 'object' ? (err as { code?: unknown })['code'] : null
    return { ok: false, status: res.status, errorCode: typeof code === 'string' ? (code as GoodsCheckoutErrorCode) : null, data }
  } catch {
    return { ok: false, status: 0, errorCode: null, data: {} }
  }
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

// ── AMC Mart M1 — group-buy pools (pay-on-close; server-computed numbers) ──

export interface MartPoolProgress { pct: number; metPct: number; met: boolean; remainingToMin: number }
export interface MartPool {
  id: string
  title: string
  unit: string
  status: 'open' | 'closed_met' | 'closed_unmet' | 'ordered' | 'fulfilled' | 'cancelled'
  target_qty: number
  min_qty: number
  unit_price_paise: number
  list_price_paise: number | null
  closes_at: string
  committed_qty: number
  member_count: number
  imageUrl: string | null
  product_id: string | null
  seller: { id: string; displayName: string; city: string | null; state: string } | null
  progress: MartPoolProgress
}
export interface MartPoolMember { id: string; qty: number; payment_state: 'blocked' | 'captured' | 'released' | 'failed'; pay_by: string | null; order_id: string | null }

export async function fetchMartPools(): Promise<{ ok: boolean; pools: MartPool[] }> {
  try {
    const res = await fetch(`${API_URL}/api/v1/mart/pools`)
    if (!res.ok) return { ok: false, pools: [] }
    const d = await res.json().catch(() => ({}))
    return { ok: true, pools: d.pools ?? [] }
  } catch {
    return { ok: false, pools: [] }
  }
}

export async function fetchMartPool(id: string, locale: string): Promise<{ ok: boolean; pool: MartPool | null; member: MartPoolMember | null; shareText: string }> {
  try {
    const res = await fetch(`${API_URL}/api/v1/mart/pools/${encodeURIComponent(id)}?locale=${locale}`, { headers: await authHeaders() })
    if (res.status === 404) return { ok: true, pool: null, member: null, shareText: '' }
    if (!res.ok) return { ok: false, pool: null, member: null, shareText: '' }
    const d = await res.json().catch(() => ({}))
    return { ok: true, pool: d.pool ?? null, member: d.member ?? null, shareText: d.shareText ?? '' }
  } catch {
    return { ok: false, pool: null, member: null, shareText: '' }
  }
}

export async function joinMartPool(id: string, qty: number, delivery: GoodsDelivery): Promise<{ ok: boolean; error: string | null; pool: MartPool | null; member: MartPoolMember | null }> {
  const res = await fetch(`${API_URL}/api/v1/mart/pools/${encodeURIComponent(id)}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ qty, delivery }),
  })
  const d = await res.json().catch(() => ({}))
  return { ok: res.ok, error: res.ok ? null : typeof d.error === 'string' ? d.error : 'failed', pool: d.pool ?? null, member: d.member ? { ...d.member, pay_by: null, order_id: null } : null }
}

export async function leaveMartPool(id: string): Promise<{ ok: boolean; error: string | null; pool: MartPool | null }> {
  const res = await fetch(`${API_URL}/api/v1/mart/pools/${encodeURIComponent(id)}/leave`, { method: 'POST', headers: await authHeaders() })
  const d = await res.json().catch(() => ({}))
  return { ok: res.ok, error: res.ok ? null : typeof d.error === 'string' ? d.error : 'failed', pool: d.pool ?? null }
}

/** Pay-on-close: the member's goods order session (same shape as goods checkout). */
export async function martPoolCheckout(id: string): Promise<{ ok: boolean; error: string | null; session: GoodsCheckoutResponse | null; orderId: string | null }> {
  const res = await fetch(`${API_URL}/api/v1/mart/pools/${encodeURIComponent(id)}/checkout`, { method: 'POST', headers: await authHeaders() })
  const d = await res.json().catch(() => ({}))
  if (res.status === 409 && d.orderId) return { ok: false, error: 'already_paid', session: null, orderId: d.orderId }
  return { ok: res.ok, error: res.ok ? null : typeof d.error === 'string' ? d.error : 'failed', session: res.ok ? (d as GoodsCheckoutResponse) : null, orderId: null }
}

export async function fetchMyMartPools(): Promise<{ ok: boolean; memberships: { member: MartPoolMember & { committed_at: string }; pool: MartPool }[] }> {
  try {
    const res = await fetch(`${API_URL}/api/v1/mart/pools/mine`, { headers: await authHeaders() })
    if (!res.ok) return { ok: false, memberships: [] }
    const d = await res.json().catch(() => ({}))
    return { ok: true, memberships: d.memberships ?? [] }
  } catch {
    return { ok: false, memberships: [] }
  }
}

export async function fetchMartDeliveryDefaults(): Promise<GoodsDelivery | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/mart/delivery-defaults`, { headers: await authHeaders() })
    if (!res.ok) return null
    const d = await res.json().catch(() => ({}))
    return d.defaults ?? null
  } catch {
    return null
  }
}
