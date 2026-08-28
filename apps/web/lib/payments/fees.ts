/**
 * Gateway fee headroom (ADR-004). The platform absorbs Razorpay's charges out
 * of its commission; the provider's transfer is ALWAYS their full
 * provider_earning_paise. This module never shrinks a transfer — it only
 * refuses loudly when the fee would not fit, so the founder sees it in
 * /admin/payouts instead of a provider seeing a short payment.
 *
 * Fee model: RAZORPAY_FEE_BPS on the CAPTURED amount (default 236 = 2 %
 * gateway fee + 18 % GST on that fee). Override in env if the account's rate
 * differs; Route transfer surcharges (if any on the account) go into the same
 * number. This is an estimate for the guard — settlement webhooks are the
 * eventual source of the exact fee (FOLLOWUPS).
 */
const DEFAULT_FEE_BPS = 236

export function gatewayFeeBps(): number {
  const raw = Number(process.env['RAZORPAY_FEE_BPS'])
  return Number.isFinite(raw) && raw >= 0 && raw <= 2000 ? Math.round(raw) : DEFAULT_FEE_BPS
}

/** Ceil so the guard errs on the side of refusing, never of under-reserving. */
export function estimateGatewayFeePaise(capturedPaise: number): number {
  return Math.ceil((capturedPaise * gatewayFeeBps()) / 10000)
}

export class FeeHeadroomError extends Error {
  constructor(
    public readonly detail: {
      transferPaise: number
      capturedPaise: number
      commissionPaise: number
      estimatedFeePaise: number
      feeBps: number
      reason: 'exceeds_captured' | 'exceeds_commission'
    },
  ) {
    super(
      `fee_headroom: transfer ${detail.transferPaise} + est. fee ${detail.estimatedFeePaise} (${detail.feeBps} bps) ` +
        `vs captured ${detail.capturedPaise}, commission ${detail.commissionPaise} — ${detail.reason}`,
    )
    this.name = 'FeeHeadroomError'
  }
}

/**
 * Two invariants, both hard:
 *  (F2) transfer + fee must fit inside the captured amount (Razorpay rejects
 *       payment-linked transfers otherwise);
 *  (ADR-004) the fee must fit inside OUR commission — the provider never bears it.
 * Throws FeeHeadroomError; callers mark the payout failed with the numbers.
 */
export function assertFeeHeadroom(input: { transferPaise: number; capturedPaise: number; commissionPaise: number }): {
  estimatedFeePaise: number
  feeBps: number
} {
  const feeBps = gatewayFeeBps()
  const estimatedFeePaise = estimateGatewayFeePaise(input.capturedPaise)
  const base = { ...input, estimatedFeePaise, feeBps }
  if (input.transferPaise + estimatedFeePaise > input.capturedPaise) {
    throw new FeeHeadroomError({ ...base, reason: 'exceeds_captured' })
  }
  if (estimatedFeePaise > input.commissionPaise) {
    throw new FeeHeadroomError({ ...base, reason: 'exceeds_commission' })
  }
  return { estimatedFeePaise, feeBps }
}
