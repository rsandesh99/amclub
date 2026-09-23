import { describe, expect, it } from 'vitest'
import { initialMobileRole, mobileRolesOf, mobileTabsFor } from '../index'

describe('E13 FR-13.1 — role-aware tab bars', () => {
  it('buyer: Home · Search · Requirements · Orders · Saved (+ Mart only when live)', () => {
    expect(mobileTabsFor({ role: 'buyer', martEnabled: false })).toEqual(['home', 'search', 'requirements', 'orders', 'saved'])
    expect(mobileTabsFor({ role: 'buyer', martEnabled: true })).toEqual(['home', 'search', 'requirements', 'orders', 'saved', 'mart'])
  })
  it('provider: Today · RFQs · Orders · Listings · Earnings — no Partner tab, no Mart', () => {
    expect(mobileTabsFor({ role: 'provider', martEnabled: true })).toEqual(['today', 'rfqs', 'orders', 'listings', 'earnings'])
  })
  it('roles from the account; the remembered choice wins only while the account still has it', () => {
    expect(mobileRolesOf({ roles: ['msme'], hasProviderProfile: false, hasMsmeProfile: true })).toEqual(['buyer'])
    expect(mobileRolesOf({ roles: ['provider'], hasProviderProfile: true, hasMsmeProfile: false })).toEqual(['provider'])
    expect(mobileRolesOf({ roles: ['msme', 'provider'], hasProviderProfile: true, hasMsmeProfile: true })).toEqual(['buyer', 'provider'])
    expect(mobileRolesOf({ roles: [], hasProviderProfile: false, hasMsmeProfile: false })).toEqual(['buyer'])
    expect(initialMobileRole(['buyer', 'provider'], 'provider')).toBe('provider')
    expect(initialMobileRole(['buyer'], 'provider')).toBe('buyer')
    expect(initialMobileRole(['provider'], null)).toBe('provider')
    expect(initialMobileRole(['buyer', 'provider'], 'bogus')).toBe('buyer')
  })
})

import { groupPayoutsForEarnings, listingToggleTarget, PAYOUT_STATUSES } from '../index'

describe('E13 FR-13.2 — earnings groups and listing toggles', () => {
  it('scheduled (incl. processing / delayed) · on hold · paid, order kept, empty groups dropped', () => {
    const rows = [{ id: 'a', status: 'paid' }, { id: 'b', status: 'held' }, { id: 'c', status: 'scheduled' }, { id: 'd', status: 'processing' }, { id: 'e', status: 'failed' }]
    expect(groupPayoutsForEarnings(rows).map((g) => [g.group, g.rows.map((r) => r.id)])).toEqual([['scheduled', ['c', 'd', 'e']], ['held', ['b']], ['paid', ['a']]])
    expect(groupPayoutsForEarnings([{ status: 'paid' }]).map((g) => g.group)).toEqual(['paid'])
    expect(groupPayoutsForEarnings([{ status: 'mystery' }]).map((g) => g.group)).toEqual(['scheduled'])
  })
  it('every payout status lands in exactly one group', () => {
    for (const s of PAYOUT_STATUSES) expect(groupPayoutsForEarnings([{ status: s }]).length).toBe(1)
  })
  it('only live / paused listings toggle on the phone', () => {
    expect(listingToggleTarget('active')).toBe('paused')
    expect(listingToggleTarget('paused')).toBe('active')
    expect(listingToggleTarget('draft')).toBeNull()
    expect(listingToggleTarget('removed')).toBeNull()
  })
})

import { mobileRouteFor } from '../index'

describe('E13 FR-13.6 — notifications open the exact screen', () => {
  const O = '11111111-1111-4111-8111-111111111111'
  it('every link shape the server sends today maps to its screen (tab / query kept)', () => {
    const v3 = { v3: true }
    expect(mobileRouteFor(`/app/orders/${O}?tab=messages`, v3)).toBe(`/orders/${O}?tab=messages`)
    expect(mobileRouteFor(`/partner/orders/${O}`, v3)).toBe(`/orders/${O}`)
    expect(mobileRouteFor('/partner/orders', v3)).toBe('/orders')
    expect(mobileRouteFor(`/app/rfq/${O}`, v3)).toBe(`/rfq/${O}`)
    expect(mobileRouteFor(`/app/rfq/new?from=${O}`, v3)).toBe(`/rfq/new?from=${O}`)
    expect(mobileRouteFor(`/partner/rfqs/${O}`, v3)).toBe(`/partner-rfq/${O}`)
    expect(mobileRouteFor('/partner/rfqs', v3)).toBe('/partner-rfqs')
    expect(mobileRouteFor('/partner/munshi', v3)).toBe('/partner-munshi')
    expect(mobileRouteFor(`/app/mart/pools/${O}`, v3)).toBe(`/mart/pool/${O}`)
    expect(mobileRouteFor(`/mart/pools/${O}`, v3)).toBe(`/mart/pool/${O}`)
    expect(mobileRouteFor('/app/mart/pools', v3)).toBe('/mart/pools')
    expect(mobileRouteFor('/partner/earnings', v3)).toBe('/partner-earnings')
    expect(mobileRouteFor('/app/invoices', v3)).toBe('/invoices')
    expect(mobileRouteFor('/partner/reviews', v3)).toBe('/partner-reviews')
  })
  it('without v3 the old mapping stands; admin / unknown / empty links stay put', () => {
    expect(mobileRouteFor('/partner/earnings', { v3: false })).toBe('/partner')
    expect(mobileRouteFor('/app/invoices', { v3: false })).toBeNull()
    expect(mobileRouteFor(`/admin/disputes/${O}`, { v3: true })).toBeNull()
    expect(mobileRouteFor('', { v3: true })).toBeNull()
    expect(mobileRouteFor('https://evil.example/x', { v3: true })).toBeNull()
    expect(mobileRouteFor('/app/orders/not-an-id', { v3: true })).toBe('/orders')
  })
})
