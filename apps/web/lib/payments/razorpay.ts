import Razorpay from 'razorpay'
import type { PaymentGateway, GatewayOrder, GatewayPayment, GatewayRefund, GatewayTransfer } from './types'

/**
 * Real Razorpay gateway — TEST MODE only (rzp_test_ keys). Requires
 * RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET. Route transfers require Route
 * activation on the account; until then createTransfer returns simulated:true.
 */
export function makeRazorpayGateway(keyId: string, keySecret: string): PaymentGateway {
  const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret })

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

    async listRefunds(razorpayPaymentId: string): Promise<GatewayRefund[]> {
      try {
        const res = await rzp.payments.fetchMultipleRefund(razorpayPaymentId, { count: 100 })
        return (res.items ?? []).map((r) => ({
          razorpayRefundId: r.id,
          amountPaise: Number(r.amount),
          status: r.status,
          receipt: r.receipt ?? null,
        }))
      } catch {
        return []
      }
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

    async listCapturedPayments(sinceUnixSeconds: number): Promise<GatewayPayment[]> {
      const res = await rzp.payments.all({ from: sinceUnixSeconds, count: 100 })
      /* eslint-disable @typescript-eslint/no-explicit-any */
      return (res.items ?? [])
        .filter((p: any) => p.status === 'captured')
        .map((p: any) => ({
          razorpayPaymentId: p.id,
          razorpayOrderId: String(p.order_id),
          amountPaise: Number(p.amount),
          status: p.status,
          ...(p.method ? { method: String(p.method) } : {}),
        }))
      /* eslint-enable @typescript-eslint/no-explicit-any */
    },
  }
}
