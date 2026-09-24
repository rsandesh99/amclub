/**
 * ADR 023 — the simulation gateway never takes money decisions on the
 * production deployment.
 *
 * Without real Razorpay keys, getPaymentGateway() returns the simulation mock
 * and the buyer's "pay" calls POST /api/v1/checkout/simulate, which
 * materialises a PAID order with no money captured. That is the point on
 * previews, CI and local drills. On the production deployment it would let
 * any signed-in buyer place a paid order for free (a client-triggered capture,
 * against rule 2: webhooks are the only payment truth). So on production a
 * missing or placeholder key means "payments unavailable", never "simulate".
 *
 * Pure: the caller passes the gateway's isReal and the Vercel environment
 * (VERCEL_ENV is 'production' | 'preview' | 'development' on Vercel, unset
 * elsewhere — CI, the money rigs and local runs keep simulating).
 */
export function paymentsAvailable(gatewayIsReal: boolean, vercelEnv: string | undefined = process.env['VERCEL_ENV']): boolean {
  return gatewayIsReal || vercelEnv !== 'production'
}

/** The machine code every checkout surface returns (503) when paymentsAvailable() is false. */
export const PAYMENTS_UNAVAILABLE = 'payments_unavailable'

/** ADR 027 (audit M2) — the code for money that would move against a SIMULATED payment on a real gateway. */
export const PAYMENT_SIMULATED = 'payment_simulated'

/**
 * ADR 027 — was this payment taken by the simulation path? The simulate route
 * records `pay_sim_<session id>` and `webhook_payload.simulated = true`; select
 * the flag as `simulated:webhook_payload->simulated` (or pass the payload).
 */
export function isSimulatedPayment(p: { razorpay_payment_id?: string | null; simulated?: unknown; webhook_payload?: unknown } | null | undefined): boolean {
  if (!p) return false
  if (typeof p.razorpay_payment_id === 'string' && p.razorpay_payment_id.startsWith('pay_sim_')) return true
  const flag = p.simulated ?? (p.webhook_payload && typeof p.webhook_payload === 'object' ? (p.webhook_payload as { simulated?: unknown }).simulated : undefined)
  return flag === true || flag === 'true'
}

/**
 * ADR 027 (audit M2) — may money move (a refund or a transfer) right now, for
 * this payment? Null = yes. Checkout already refuses on production without real
 * keys (ADR 023); this is the same rule for everything AFTER checkout:
 *  • `payments_unavailable` — the gateway is the simulation mock on the
 *    production deployment: a "refund" or "transfer" would move no money but
 *    record that it did. The row is left as it is.
 *  • `payment_simulated` — a real gateway, but the payment was simulated: there
 *    is no money at Razorpay to refund, and a transfer would pay the provider
 *    real money for an order nobody paid for.
 * Previews, CI and the rigs (mock gateway, no production VERCEL_ENV) pass.
 */
export function moneyMovementBlock(
  gatewayIsReal: boolean,
  payment?: Parameters<typeof isSimulatedPayment>[0],
  vercelEnv: string | undefined = process.env['VERCEL_ENV'],
): typeof PAYMENTS_UNAVAILABLE | typeof PAYMENT_SIMULATED | null {
  if (!paymentsAvailable(gatewayIsReal, vercelEnv)) return PAYMENTS_UNAVAILABLE
  if (gatewayIsReal && isSimulatedPayment(payment)) return PAYMENT_SIMULATED
  return null
}

/** Thrown by the refund engine when moneyMovementBlock() refuses; nothing was written. */
export class MoneyPathBlockedError extends Error {
  constructor(public readonly code: typeof PAYMENTS_UNAVAILABLE | typeof PAYMENT_SIMULATED) {
    super(code)
    this.name = 'MoneyPathBlockedError'
  }
}

/**
 * ADR 027 (audit M21) — the Razorpay Checkout `timeout` (seconds) for a session:
 * the sheet closes when the frozen session expires, so a payment cannot start
 * after it. Null when the session has no expiry (the sheet's own default).
 * Computed on the server; the client passes it through.
 */
export function checkoutTimeoutSeconds(expiresAt: string | null | undefined, now = Date.now()): number | null {
  if (!expiresAt) return null
  const ms = new Date(expiresAt).getTime() - now
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.floor(ms / 1000))
}

/** Below this many seconds left, a session is not resumed: the buyer starts a fresh checkout. */
export const MIN_RESUME_SECONDS = 60
