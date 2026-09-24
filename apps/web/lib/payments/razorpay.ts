import Razorpay from 'razorpay'
import type { PaymentGateway, GatewayOrder, GatewayPayment, GatewayRefund, GatewayTransfer } from './types'
import { OUTBOUND_TIMEOUT_MS } from '@/lib/outbound'

/**
 * Real Razorpay gateway — TEST MODE only (rzp_test_ keys). Requires
 * RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET. Route transfers require Route
 * activation on the account; until then createTransfer returns simulated:true.
 */
export function makeRazorpayGateway(keyId: string, keySecret: string): PaymentGateway {
  const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret })
  // Audit M37 — a deadline on every Razorpay call. The SDK takes no timeout option; it
  // sends through one axios instance (`api.rq`, untyped), whose defaults apply per request.
  // A timed-out call rejects without a statusCode, so the payout path reads it as
  // "outcome unknown" (unconfirmed, looked up before any retry), never as a refusal.
  const http = (rzp.api as unknown as { rq?: { defaults?: { timeout?: number } } }).rq
  if (http?.defaults) http.defaults.timeout = OUTBOUND_TIMEOUT_MS.payments

  return {
    isReal: true,

    async createOrder({ amountPaise, receipt, notes }): Promise<GatewayOrder> {
      const order = await rzp.orders.create({
        amount: amountPaise, // Razorpay amount is in paise
        currency: 'INR',
        receipt,
        notes: notes ?? {},
      })
      return {
        razorpayOrderId: order.id,
        amountPaise: Number(order.amount),
        currency: order.currency,
        status: order.status,
      }
    },

    async createRefund({ razorpayPaymentId, amountPaise, receipt, notes }): Promise<GatewayRefund> {
      const refund = await rzp.payments.refund(razorpayPaymentId, {
        amount: amountPaise,
        ...(receipt ? { receipt } : {}),
        notes: notes ?? {},
      })
      return {
        razorpayRefundId: refund.id,
        amountPaise: Number(refund.amount),
        status: refund.status,
        receipt: refund.receipt ?? null,
      }
    },

    // Throws when the lookup fails: processRefund relies on it to find a refund
    // it already made, and an empty answer on an error would refund twice (ADR 026).
    async listRefunds(razorpayPaymentId: string): Promise<GatewayRefund[]> {
      const res = await rzp.payments.fetchMultipleRefund(razorpayPaymentId, { count: 100 })
      return (res.items ?? []).map((r) => ({
        razorpayRefundId: r.id,
        amountPaise: Number(r.amount),
        status: r.status,
        receipt: r.receipt ?? null,
      }))
    },

    async createTransfer({ linkedAccountId, amountPaise, notes }): Promise<GatewayTransfer> {
      // Route transfer needs an activated account + linked account id. With a
      // REAL gateway a missing linked account must FAIL (payout → 'failed',
      // visible in /admin/payouts) — never silently simulate a "paid" state
      // while the money stays in the platform account. Simulation belongs to
      // the mock gateway only.
      if (!linkedAccountId) {
        throw new Error('route_account_missing: provider has no Razorpay Route linked account')
      }
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const transfer = await (rzp as any).transfers.create({
        account: linkedAccountId,
        amount: amountPaise,
        currency: 'INR',
        notes: notes ?? {},
      })
      /* eslint-enable @typescript-eslint/no-explicit-any */
      return {
        razorpayTransferId: transfer.id,
        amountPaise: Number(transfer.amount),
        status: transfer.status,
        simulated: false,
      }
    },

    async findTransfer({ payoutId, sinceUnixSeconds }): Promise<GatewayTransfer | null> {
      // Newest first, 100 a page; ten pages bound the scan. Past that the answer
      // is unknown, never "none".
      /* eslint-disable @typescript-eslint/no-explicit-any */
      for (let page = 0; page < 10; page++) {
        const res = await (rzp as any).transfers.all({ from: sinceUnixSeconds, count: 100, skip: page * 100 })
        const items: any[] = res?.items ?? []
        const hit = items.find((t) => t?.notes?.payout_id === payoutId)
        if (hit) return { razorpayTransferId: String(hit.id), amountPaise: Number(hit.amount), status: String(hit.status), simulated: false }
        if (items.length < 100) return null
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
      throw new Error('transfer_lookup_exhausted')
    },

    async fetchPayment(razorpayPaymentId: string): Promise<GatewayPayment | null> {
      try {
        const p = await rzp.payments.fetch(razorpayPaymentId)
        return {
          razorpayPaymentId: p.id,
          razorpayOrderId: String(p.order_id),
          amountPaise: Number(p.amount),
          status: p.status,
          ...(p.method ? { method: String(p.method) } : {}),
        }
      } catch {
        return null
      }
    },

    // Pages through every payment in the window (audit M39: it read only the
    // first 100, so a busy 48 h left dropped webhooks unrecovered).
    async listCapturedPayments(sinceUnixSeconds: number): Promise<GatewayPayment[]> {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const out: GatewayPayment[] = []
      for (let page = 0; page < 50; page++) {
        const res = await rzp.payments.all({ from: sinceUnixSeconds, count: 100, skip: page * 100 })
        const items: any[] = res.items ?? []
        for (const p of items) {
          if (p.status !== 'captured') continue
          out.push({
            razorpayPaymentId: p.id,
            razorpayOrderId: String(p.order_id),
            amountPaise: Number(p.amount),
            status: p.status,
            ...(p.method ? { method: String(p.method) } : {}),
          })
        }
        if (items.length < 100) break
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
      return out
    },
  }
}
