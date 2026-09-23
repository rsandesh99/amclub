import { PAYOUT_STATUS, type PayoutStatus } from './state-machines'
/**
 * PRD Experience v3 E13 — mobile parity (flag `mobile`, read from
 * /profile/me.mobileV3Enabled). FR-13.1: role-aware tab bars identical to
 * the web shell (E1). A user with both roles switches from the profile
 * (avatar) sheet; the choice is remembered on the device.
 */

export type MobileRole = 'buyer' | 'provider'

/** Tab keys (the Expo route each opens is the app's concern). Mart only while the server flag is on. */
export const MOBILE_BUYER_TABS = ['home', 'search', 'requirements', 'orders', 'saved'] as const
export const MOBILE_PROVIDER_TABS = ['today', 'rfqs', 'orders', 'listings', 'earnings'] as const
export type MobileTab = (typeof MOBILE_BUYER_TABS)[number] | (typeof MOBILE_PROVIDER_TABS)[number] | 'mart'

export function mobileTabsFor(opts: { role: MobileRole; martEnabled: boolean }): MobileTab[] {
  if (opts.role === 'provider') return [...MOBILE_PROVIDER_TABS]
  return opts.martEnabled ? [...MOBILE_BUYER_TABS, 'mart'] : [...MOBILE_BUYER_TABS]
}

/** Which roles the account can switch between (users.roles; a provider profile counts). */
export function mobileRolesOf(input: { roles: readonly string[]; hasProviderProfile: boolean; hasMsmeProfile: boolean }): MobileRole[] {
  const out: MobileRole[] = []
  if (input.roles.includes('msme') || input.hasMsmeProfile) out.push('buyer')
  if (input.roles.includes('provider') || input.hasProviderProfile) out.push('provider')
  return out.length ? out : ['buyer']
}

/** The role the tab bar opens in: the device's last choice when the account still has it, else provider-first for a provider-only account. */
export function initialMobileRole(available: readonly MobileRole[], stored: string | null | undefined): MobileRole {
  if (stored === 'buyer' || stored === 'provider') {
    if (available.includes(stored)) return stored
  }
  return available.includes('buyer') ? 'buyer' : 'provider'
}

// ── FR-13.2 Earnings: the ledger grouped the way the web earnings page reads ──────────

export const EARNINGS_GROUPS = ['scheduled', 'held', 'paid'] as const
export type EarningsGroup = (typeof EARNINGS_GROUPS)[number]

const GROUP_OF: Record<PayoutStatus, EarningsGroup> = {
  [PAYOUT_STATUS.scheduled]: 'scheduled',
  [PAYOUT_STATUS.processing]: 'scheduled',
  [PAYOUT_STATUS.failed]: 'scheduled', // retried by the payout job; shown as delayed, not lost
  [PAYOUT_STATUS.held]: 'held',
  [PAYOUT_STATUS.paid]: 'paid',
}

/** Group payout rows (order kept); an unknown status never disappears — it shows as scheduled. */
export function groupPayoutsForEarnings<T extends { status: string }>(rows: readonly T[]): { group: EarningsGroup; rows: T[] }[] {
  return EARNINGS_GROUPS.map((group) => ({ group, rows: rows.filter((r) => (GROUP_OF[r.status as PayoutStatus] ?? 'scheduled') === group) })).filter((g) => g.rows.length > 0)
}

/** Listings the phone may pause / resume (the rest are edited on the web). */
export function listingToggleTarget(status: string): 'active' | 'paused' | null {
  return status === 'active' ? 'paused' : status === 'paused' ? 'active' : null
}
