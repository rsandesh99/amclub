/**
 * Payout readiness (Phase 3a) — the two facts a provider needs before a Route
 * transfer can succeed: a Razorpay Route linked account on file AND a
 * verified bank account (penny-drop or the audited admin override).
 * Pure helper, shared by the admin providers list, provider detail and the
 * payouts monitor so the definition lives in one place.
 */
export type PayoutReadiness = 'ready' | 'missing_route' | 'bank_unverified' | 'not_ready' | 'no_bank'

export interface BankFacts {
  onFile: boolean
  pennyDropVerified: boolean
  hasRouteAccount: boolean
}

export function bankFacts(row: { penny_drop_verified?: boolean | null; razorpay_route_account_id?: string | null } | null | undefined): BankFacts {
  if (!row) return { onFile: false, pennyDropVerified: false, hasRouteAccount: false }
  return {
    onFile: true,
    pennyDropVerified: Boolean(row.penny_drop_verified),
    hasRouteAccount: Boolean(row.razorpay_route_account_id),
  }
}

export function payoutReadiness(b: BankFacts): PayoutReadiness {
  if (!b.onFile) return 'no_bank'
  if (b.hasRouteAccount && b.pennyDropVerified) return 'ready'
  if (!b.hasRouteAccount && !b.pennyDropVerified) return 'not_ready'
  if (!b.hasRouteAccount) return 'missing_route'
  return 'bank_unverified'
}

export const READINESS_VALUES: readonly PayoutReadiness[] = ['ready', 'missing_route', 'bank_unverified', 'not_ready', 'no_bank']
