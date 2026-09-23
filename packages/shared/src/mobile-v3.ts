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

// ── FR-13.6 the deep-link contract: a notification's web link → the exact mobile screen ─
const UUIDISH = /^[0-9a-f-]{8,}$/i

/**
 * Map a notification's web app-relative link (with its query) to the mobile
 * route that shows the same thing. `v3` adds the E13 screens; without it the
 * v2 mapping stands (earnings → the provider home). Unknown links → null (the
 * caller stays on the notification list, or opens the web).
 */
export function mobileRouteFor(link: string | null | undefined, opts: { v3: boolean }): string | null {
  if (!link || !link.startsWith('/')) return null
  const [path = '', query = ''] = link.split('?')
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
  const q = query ? `?${query}` : ''
  const id = (i: number) => (parts[i] && UUIDISH.test(parts[i]!) ? parts[i]! : null)
  const [a, b, c] = parts
  if ((a === 'app' || a === 'partner') && b === 'orders') return id(2) ? `/orders/${id(2)}${q}` : '/orders'
  if (a === 'app' && b === 'rfq') {
    if (c === 'new') return `/rfq/new${q}`
    return id(2) ? `/rfq/${id(2)}${q}` : '/rfq'
  }
  if (a === 'partner' && b === 'rfqs') return id(2) ? `/partner-rfq/${id(2)}${q}` : '/partner-rfqs'
  if (a === 'partner' && b === 'munshi') return '/partner-munshi'
  if (a === 'app' && b === 'assistant') return '/assistant'
  if ((a === 'app' || a === 'mart') && (b === 'mart' || b === 'pools')) {
    const poolId = a === 'mart' ? id(2) : c === 'pools' ? id(3) : null
    return poolId ? `/mart/pool/${poolId}` : '/mart/pools'
  }
  if (a === 'partner' && b === 'earnings') return opts.v3 ? '/partner-earnings' : '/partner'
  if (opts.v3) {
    if (a === 'partner' && b === 'listings') return '/partner-listings'
    if (a === 'partner' && b === 'reviews') return '/partner-reviews'
    if (a === 'partner' && b === 'insights') return '/partner-insights'
    if (a === 'partner' && b === 'profile') return '/partner-profile'
    if (a === 'app' && b === 'invoices') return '/invoices'
    if (a === 'partner' && b === 'onboarding') return `/partner-onboarding${q}`
  }
  if (a === 'partner' && (b === undefined || b === 'actions')) return '/partner'
  if (a === 'app' && (b === undefined || b === 'actions')) return '/home'
  return null
}
