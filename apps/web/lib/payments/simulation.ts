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
