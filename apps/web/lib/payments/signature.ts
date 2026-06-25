import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Razorpay webhook signature verification. CRITICAL: the HMAC must be computed
 * over the EXACT raw request body bytes — never a re-serialized JSON object,
 * whose key order/whitespace would differ and silently fail verification.
 *
 * Caller must pass `await request.text()` (the raw body) BEFORE JSON.parse.
 */

const DEV_WEBHOOK_SECRET = 'whsec_test_amclub_dev'

/** The webhook secret in use. Falls back to a known dev value (with a warning)
 *  so the idempotency/reconciliation kill-tests can run without real keys. */
export function getWebhookSecret(): string {
  const s = process.env['RAZORPAY_WEBHOOK_SECRET']
  if (s && !s.startsWith('<') && s !== 'placeholder' && s.length > 0) return s
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('RAZORPAY_WEBHOOK_SECRET missing in production — refusing to accept webhooks.')
  }
  console.warn('⚠ RAZORPAY_WEBHOOK_SECRET not set — using dev webhook secret. Provision before live.')
  return DEV_WEBHOOK_SECRET
}

/** Compute the Razorpay-style HMAC-SHA256 hex signature over a raw body. */
export function signWebhookBody(rawBody: string, secret = getWebhookSecret()): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

/** Constant-time verify of the `x-razorpay-signature` header against the raw body. */
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false
  const expected = signWebhookBody(rawBody)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
