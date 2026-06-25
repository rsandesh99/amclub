import { randomBytes } from 'crypto'
import type { PaymentGateway, GatewayOrder, GatewayPayment, GatewayRefund, GatewayTransfer } from './types'

const rid = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`

/**
 * Simulation gateway — used when real Razorpay keys aren't provided. It returns
 * plausible ids so the full order/webhook/refund/payout loop is exercisable
 * end-to-end without a real account. In simulation the buyer's "pay" action
 * triggers a SIGNED simulated webhook to the real webhook handler, so the
 * idempotency path is the same as production.
 *
 * listCapturedPayments returns [] — runtime reconciliation only matters with a
 * real gateway; the dropped-webhook kill-test injects a stub gateway directly.
 */
export const mockGateway: PaymentGateway = {
  isReal: false,

  async createOrder({ amountPaise }): Promise<GatewayOrder> {
    return { razorpayOrderId: rid('order'), amountPaise, currency: 'INR', status: 'created' }
  },

  async createRefund({ amountPaise }): Promise<GatewayRefund> {
    return { razorpayRefundId: rid('rfnd'), amountPaise, status: 'processed' }
  },

  async createTransfer({ amountPaise }): Promise<GatewayTransfer> {
    return { razorpayTransferId: rid('trf'), amountPaise, status: 'created', simulated: true }
  },

  async fetchPayment(razorpayPaymentId: string): Promise<GatewayPayment | null> {
    return {
      razorpayPaymentId,
      razorpayOrderId: rid('order'),
      amountPaise: 0,
      status: 'captured',
      method: 'upi',
    }
  },

  async listCapturedPayments(): Promise<GatewayPayment[]> {
    return []
  },
}
