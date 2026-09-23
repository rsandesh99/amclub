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
