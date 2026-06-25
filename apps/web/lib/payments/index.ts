import type { PaymentGateway } from './types'
import { mockGateway } from './mock'
import { makeRazorpayGateway } from './razorpay'

function isPlaceholder(v: string | undefined): boolean {
  return !v || v.startsWith('<') || v === 'placeholder' || v.length === 0
}

/**
 * Returns the real Razorpay TEST gateway when both keys are present, otherwise
 * the simulation mock. Logs which one is active so it's never ambiguous whether
 * real test calls are being made.
 */
let warned = false
export function getPaymentGateway(): PaymentGateway {
  const keyId = process.env['RAZORPAY_KEY_ID']
  const keySecret = process.env['RAZORPAY_KEY_SECRET']

  if (!isPlaceholder(keyId) && !isPlaceholder(keySecret)) {
    if (keyId!.startsWith('rzp_live_')) {
      throw new Error('Refusing to use rzp_live_ keys in Phase 4 — TEST MODE only.')
    }
    return makeRazorpayGateway(keyId!, keySecret!)
  }

  if (!warned) {
    console.warn(
      '⚠ Razorpay secret not set — using SIMULATION gateway. Provide RAZORPAY_KEY_SECRET (rzp_test) to make real test-mode calls.',
    )
    warned = true
  }
  return mockGateway
}

export * from './types'
export { getWebhookSecret, signWebhookBody, verifyWebhookSignature } from './signature'
