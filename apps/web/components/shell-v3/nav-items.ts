import type { LucideIcon } from 'lucide-react'
import { ClipboardList, Heart, Home, Inbox, LayoutGrid, Package, Receipt, Search, ShoppingBag, Sparkles, Star, Sun, User, Wallet } from 'lucide-react'
import type { MeActions } from '@amclub/shared'

export interface NavItem {
  href: string
  labelKey: string
  icon: LucideIcon
  /** Pick the badge count from /me/actions. */
  badge?: (a: MeActions) => number
  /** Match only this exact path (home). */
  exact?: boolean
  /** Desktop rail only (the phone tab bar holds 5). */
  railOnly?: boolean
}

/** Buyer nav (PRD §4.2): Home · Search · Requirements · Orders · Saved (+ Mart when live, + the assistant home when AGENT_ENABLED). */
export function buyerNav(martEnabled: boolean, agentEnabled = false): NavItem[] {
  return [
    { href: '/app', labelKey: 'home', icon: Home, exact: true },
    { href: '/app/search', labelKey: 'search', icon: Search },
    { href: '/app/rfq', labelKey: 'requirements', icon: ClipboardList, badge: (a) => a.buyer?.counts.requirements ?? 0 },
    { href: '/app/orders', labelKey: 'orders', icon: Package, badge: (a) => a.buyer?.counts.orders ?? 0 },
    { href: '/app/saved', labelKey: 'saved', icon: Heart },
    ...(martEnabled ? [{ href: '/mart', labelKey: 'mart', icon: ShoppingBag, railOnly: true } as NavItem] : []),
    { href: '/app/invoices', labelKey: 'invoices', icon: Receipt, railOnly: true },
    ...(agentEnabled ? [{ href: '/app/ai', labelKey: 'assistant', icon: Sparkles, railOnly: true } as NavItem] : []),
    { href: '/app/profile', labelKey: 'profile', icon: User, railOnly: true },
  ]
}

/** Provider nav (PRD §4.2): Today · RFQs · Orders · Listings · Earnings (+ Reviews, Profile on the rail). */
export function providerNav(agentEnabled = false): NavItem[] {
  return [
    { href: '/partner', labelKey: 'today', icon: Sun, exact: true },
    { href: '/partner/rfqs', labelKey: 'rfqs', icon: Inbox, badge: (a) => a.provider?.counts.rfqs ?? 0 },
    { href: '/partner/orders', labelKey: 'orders', icon: Package, badge: (a) => a.provider?.counts.orders ?? 0 },
    { href: '/partner/listings', labelKey: 'listings', icon: LayoutGrid },
    { href: '/partner/earnings', labelKey: 'earnings', icon: Wallet },
    { href: '/partner/reviews', labelKey: 'reviews', icon: Star, railOnly: true },
    ...(agentEnabled ? [{ href: '/partner/ai', labelKey: 'assistant', icon: Sparkles, railOnly: true } as NavItem] : []),
    { href: '/partner/profile', labelKey: 'profile', icon: User, railOnly: true },
  ]
}

export function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href
  return pathname === item.href || pathname.startsWith(`${item.href}/`)
}
