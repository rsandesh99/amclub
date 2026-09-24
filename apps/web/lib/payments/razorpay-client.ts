/**
 * The ONE browser-side path from a created checkout session to a payment
 * (package Buy Now, RFQ quote accept, Mart goods checkout). It never decides
 * payment state: the Razorpay WEBHOOK materialises the order (§2.5); the
 * `handler` redirect is cosmetic. In simulation (no Razorpay keys) it calls the
 * same idempotent materialise path via /api/v1/checkout/simulate. It does no
 * money arithmetic — the amount shown in the sheet is the server's frozen
 * session total.
 *
 * Errors are thrown as CheckoutError with a stable `code` so callers can map
 * them to translated copy; a raw server string is never surfaced to users.
 */

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void }
  }
}

/** Response body of POST /api/v1/checkout and /api/v1/mart/checkout. */
export interface CheckoutStart {
  checkoutSessionId: string
  razorpayOrderId?: string | null
  amountPaise?: number
  keyId?: string
  simulated?: boolean
  idempotent?: boolean
  /** Resume of a session whose payment was already captured. */
  alreadyPaid?: boolean
  orderId?: string | null
  /** ADR 027 (M21) — seconds until the frozen session expires; the sheet closes then (Razorpay `timeout`). */
  checkoutTimeoutSeconds?: number
}

export class CheckoutError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'CheckoutError'
  }
}

/**
 * Pull the machine code out of an error body: `{ code }` (checkout route) or
 * `{ error: { code } }` (Mart routes). Falls back to 'failed'.
 */
export function errorCodeOf(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as { code?: unknown; error?: unknown }
    if (typeof b.code === 'string') return b.code
    if (b.error && typeof b.error === 'object' && typeof (b.error as { code?: unknown }).code === 'string') {
      return (b.error as { code: string }).code
    }
  }
  return 'failed'
}

/** Server/client error code → key in the `checkout` messages namespace. Anything else → `failed`. */
export const CHECKOUT_ERROR_KEYS: Record<string, string> = {
  unauthorized: 'err_unauthorized',
  profile_incomplete: 'err_profile_incomplete',
  package_unavailable: 'err_package_unavailable',
  provider_paused: 'err_provider_paused',
  gstin_invalid: 'err_gstin_invalid',
  quote_not_found: 'err_quote_unavailable',
  quote_unavailable: 'err_quote_unavailable',
  goods_quote_unavailable: 'err_quote_unavailable',
  rfq_closed: 'err_rfq_closed',
  rfq_checkout_in_progress: 'err_rfq_checkout_in_progress',
  rfq_already_paid: 'err_rfq_already_paid',
  addon_changed: 'err_addon_changed',
  option_not_found: 'err_quote_unavailable',
  razorpay_load_failed: 'err_razorpay_load_failed',
  payments_unavailable: 'err_payments_unavailable',
  checkout_expired: 'err_checkout_expired',
  // Audit M10 — the coupon's last use (total or per buyer) went to another checkout.
  coupon_unavailable: 'err_coupon_unavailable',
  // Audit M22 — a buyer's own provider (or seller) profile.
  self_dealing: 'err_self_dealing',
  network: 'err_network',
  rate_limited: 'err_rate_limited',
}

/** ADR 027 (M21) — the server refused to resume an expired session: the caller drops its idempotency key so the next tap starts a fresh checkout. */
export function isCheckoutExpired(e: unknown): boolean {
  return e instanceof CheckoutError && e.code === 'checkout_expired'
}

/** Map a code to a translation key via `keys`; unknown codes → `fallback`. */
export function checkoutErrorKey(e: unknown, keys: Record<string, string>, fallback: string): string {
  const code = e instanceof CheckoutError ? e.code : 'failed'
  return keys[code] ?? fallback
}

export function loadRazorpay(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve()
    const s = document.createElement('script')
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    s.onload = () => resolve()
    s.onerror = () => reject(new CheckoutError('razorpay_load_failed'))
    document.body.appendChild(s)
  })
}

/** POST a checkout body; throws CheckoutError(code) on a non-2xx. */
export async function startCheckout(url: string, body: Record<string, unknown>): Promise<CheckoutStart> {
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new CheckoutError('network')
  }
  const data = await res.json().catch(() => null)
  if (res.status === 429) throw new CheckoutError('rate_limited')
  if (!res.ok || !data) throw new CheckoutError(errorCodeOf(data))
  return data as CheckoutStart
}

export type PaymentOutcome =
  /** Order exists now (simulation, or an already-paid resume) — go to it. */
  | { kind: 'order'; orderId: string }
  /** Real sheet was opened; the buyer completed it or the payment was already captured without a known order id. */
  | { kind: 'processing' }

/**
 * Drive a started checkout to payment. Simulation → materialise now and return
 * the order. Real keys → open the Razorpay sheet; `onPaid` fires from the sheet
 * handler (cosmetic — the webhook creates the order), `onDismiss` when the
 * buyer closes it without paying. Resolves once the sheet is open.
 */
export async function payCheckout(
  data: CheckoutStart,
  opts: { description: string; onPaid: (o: PaymentOutcome) => void; onDismiss: () => void },
): Promise<void> {
  if (data.alreadyPaid) {
    opts.onPaid(data.orderId ? { kind: 'order', orderId: data.orderId } : { kind: 'processing' })
    return
  }
  if (data.simulated) {
    const res = await fetch('/api/v1/checkout/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutSessionId: data.checkoutSessionId }),
    }).catch(() => null)
    const sd = res ? await res.json().catch(() => null) : null
    if (!res || !res.ok || !sd?.orderId) throw new CheckoutError(res ? errorCodeOf(sd) : 'network')
    opts.onPaid({ kind: 'order', orderId: String(sd.orderId) })
    return
  }
  if (!data.razorpayOrderId || !data.keyId) throw new CheckoutError('failed')
  await loadRazorpay()
  if (!window.Razorpay) throw new CheckoutError('razorpay_load_failed')
  const rzp = new window.Razorpay({
    key: data.keyId,
    order_id: data.razorpayOrderId,
    amount: data.amountPaise,
    currency: 'INR',
    name: 'AMClub',
    description: opts.description,
    // ADR 027 (M21): the sheet closes when the server's frozen session expires (a
    // later capture creates no order and is refunded in full).
    ...(typeof data.checkoutTimeoutSeconds === 'number' && data.checkoutTimeoutSeconds > 0 ? { timeout: data.checkoutTimeoutSeconds } : {}),
    // Redirect is cosmetic; the order appears once the webhook fires.
    handler: () => opts.onPaid({ kind: 'processing' }),
    modal: { ondismiss: () => opts.onDismiss() },
  })
  rzp.open()
}

/** A fresh idempotency key (one per checkout intent, reused across retries). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}
