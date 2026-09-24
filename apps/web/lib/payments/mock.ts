import { randomBytes } from 'crypto'
import type { PaymentGateway, GatewayOrder, GatewayPayment, GatewayRefund, GatewayTransfer } from './types'

const rid = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`

/** In-memory refund ledger per payment (process-local; enough for kill-tests). */
const mockRefunds = new Map<string, GatewayRefund[]>()
/** In-memory transfer ledger per payout id, so findTransfer behaves like the real gateway (ADR 026).
 *  On globalThis: every route bundle of the server process sees the same ledger. */
const g = globalThis as unknown as { __amcMockTransfers?: Map<string, GatewayTransfer> }
const mockTransfers = (g.__amcMockTransfers ??= new Map<string, GatewayTransfer>())

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

  async createRefund({ razorpayPaymentId, amountPaise, receipt }): Promise<GatewayRefund> {
    // Mirror the real gateway's receipt semantics so the retry path
    // (listRefunds → match receipt) is exercised end-to-end in simulation.
    const refund: GatewayRefund = { razorpayRefundId: rid('rfnd'), amountPaise, status: 'processed', receipt: receipt ?? null }
    const list = mockRefunds.get(razorpayPaymentId) ?? []
    list.push(refund)
    mockRefunds.set(razorpayPaymentId, list)
    return refund
  },

  async listRefunds(razorpayPaymentId: string): Promise<GatewayRefund[]> {
    return mockRefunds.get(razorpayPaymentId) ?? []
  },

  async createTransfer({ amountPaise, notes }): Promise<GatewayTransfer> {
    const transfer: GatewayTransfer = { razorpayTransferId: rid('trf'), amountPaise, status: 'created', simulated: true }
    mockTransfers.set(notes.payout_id, transfer)
    return transfer
  },

  async findTransfer({ payoutId }): Promise<GatewayTransfer | null> {
    return mockTransfers.get(payoutId) ?? null
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
