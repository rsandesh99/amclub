/**
 * Payment gateway abstraction. The whole money loop runs behind this interface
 * so it works in simulation (mock) today and swaps to real Razorpay TEST keys
 * the moment RAZORPAY_KEY_SECRET is provided — no payment logic is skipped.
 *
 * NEVER use live keys here without explicit founder sign-off (§ Phase 4).
 */

export interface GatewayOrder {
  razorpayOrderId: string
  amountPaise: number
  currency: string
  status: string
}

export interface GatewayPayment {
  razorpayPaymentId: string
  razorpayOrderId: string
  amountPaise: number
  /** created | authorized | captured | refunded | failed */
  status: string
  method?: string
}

export interface GatewayRefund {
  razorpayRefundId: string
  amountPaise: number
  status: string
}

export interface GatewayTransfer {
  razorpayTransferId: string
  amountPaise: number
  status: string
  simulated: boolean
}

export interface PaymentGateway {
  /** true when backed by real Razorpay keys; false for the simulation mock. */
  readonly isReal: boolean

  createOrder(params: {
    amountPaise: number
    receipt: string
    notes?: Record<string, string>
    idempotencyKey?: string
  }): Promise<GatewayOrder>

  createRefund(params: {
    razorpayPaymentId: string
    amountPaise: number
    notes?: Record<string, string>
  }): Promise<GatewayRefund>

  /** Razorpay Route transfer to a provider's linked account (payout). */
  createTransfer(params: {
    linkedAccountId: string | null
    amountPaise: number
    notes?: Record<string, string>
  }): Promise<GatewayTransfer>

  /** Fetch a single payment — used by reconciliation / dropped-webhook recovery. */
  fetchPayment(razorpayPaymentId: string): Promise<GatewayPayment | null>

  /** List captured payments since a unix-seconds timestamp — reconciliation cron. */
  listCapturedPayments(sinceUnixSeconds: number): Promise<GatewayPayment[]>
}
