import { describe, expect, it } from 'vitest'
import {
  actionItemSchema,
  buyAgainSchema,
  dismissUntil,
  HOME_DISMISS_DAYS,
  isDismissed,
  isPriceChanged,
  isQuoteExpiringSoon,
  ORDER_REPEATABLE_STATUSES,
  ORDER_STATUSES,
  orderPriceDisplay,
  pickBuyAgainOrders,
  priceDisplay,
  quoteValidityEndsAt,
  repeatRequirementHref,
  sortActionItems,
  computeOrderAmounts,
} from '../index'

describe('E9 FR-9.1 action items', () => {
  it('is a discriminated union: quote_expiring needs a provider name, quotes_waiting may carry fromPaise', () => {
    const base = { objectId: 'x', title: 't', action: null, count: null, dueAt: null, href: '/app/rfq/x' }
    expect(actionItemSchema.safeParse({ kind: 'quote_expiring', ...base }).success).toBe(false)
    expect(actionItemSchema.safeParse({ kind: 'quote_expiring', ...base, providerName: 'Rao Associates' }).success).toBe(true)
    expect(actionItemSchema.safeParse({ kind: 'quotes_waiting', ...base, count: 3, fromPaise: 531000 }).success).toBe(true)
    // E1 payloads (no fromPaise) still parse.
    expect(actionItemSchema.safeParse({ kind: 'quotes_waiting', ...base, count: 3 }).success).toBe(true)
    expect(actionItemSchema.safeParse({ kind: 'unknown', ...base }).success).toBe(false)
  })

  it('a quote valid until an IST date ends at 23:59:59.999 IST that day', () => {
    expect(quoteValidityEndsAt('2026-10-02')).toBe('2026-10-02T18:29:59.999Z')
    expect(quoteValidityEndsAt('2 Oct')).toBeNull()
    expect(quoteValidityEndsAt(null)).toBeNull()
  })

  it('expiring = still valid and ending within 48 h', () => {
    const now = new Date('2026-09-30T06:30:00Z') // 12:00 IST, 30 Sep
    expect(isQuoteExpiringSoon('2026-09-30', now)).toBe(true) // ends tonight
    expect(isQuoteExpiringSoon('2026-10-01', now)).toBe(true) // ~36 h
    expect(isQuoteExpiringSoon('2026-10-02', now)).toBe(false) // ~60 h
    expect(isQuoteExpiringSoon('2026-09-29', now)).toBe(false) // already expired
    expect(isQuoteExpiringSoon(null, now)).toBe(false)
  })

  it('rows sort by deadline, undated last (the home order)', () => {
    const rows = [
      { title: 'b', dueAt: null },
      { title: 'a', dueAt: '2026-10-03T00:00:00Z' },
      { title: 'c', dueAt: '2026-10-01T00:00:00Z' },
    ]
    expect(sortActionItems(rows).map((r) => r.title)).toEqual(['c', 'a', 'b'])
  })
})

describe('E9 FR-9.3 buy again', () => {
  it('then = what the order charged (stored amounts); now = today’s checkout price', () => {
    const a = computeOrderAmounts({ pricePaise: 100000, discountBps: 1000, commissionBps: 1000, extraDiscountPaise: 5000 })
    const then = orderPriceDisplay({ pricePaise: a.pricePaise, discountPaise: a.discountPaise, gstPaise: a.gstPaise, totalPaise: a.totalPaise })
    expect(then).toMatchObject({ listPaise: 100000, discountPaise: 15000, taxablePaise: 85000, gstPaise: a.gstPaise, totalPaise: a.totalPaise, gstBps: 1800 })
    const now = priceDisplay({ pricePaise: 118000, discountBps: 0 })
    expect(isPriceChanged(then, now)).toBe(true)
    expect(isPriceChanged(now, priceDisplay({ pricePaise: 118000, discountBps: 0 }))).toBe(false)
  })

  it('the shelf: newest completed first, one row per package, at most 4, package orders only', () => {
    const o = (id: string, packageId: string | null, completedAt: string) => ({ id, packageId, completedAt, createdAt: '2026-01-01T00:00:00Z' })
    const picked = pickBuyAgainOrders([
      o('1', 'p1', '2026-09-01T00:00:00Z'),
      o('2', 'p2', '2026-09-05T00:00:00Z'),
      o('3', 'p1', '2026-09-10T00:00:00Z'),
      o('4', null, '2026-09-11T00:00:00Z'),
      o('5', 'p3', '2026-08-01T00:00:00Z'),
      o('6', 'p4', '2026-07-01T00:00:00Z'),
      o('7', 'p5', '2026-06-01T00:00:00Z'),
    ])
    expect(picked.map((x) => x.id)).toEqual(['3', '2', '5', '6'])
  })

  it('repeat requirement is the existing repost, tagged buy_again', () => {
    expect(repeatRequirementHref('11111111-1111-4111-8111-111111111111')).toBe('/app/rfq/new?from=11111111-1111-4111-8111-111111111111&entry=buy_again')
  })

  it('repeatable statuses are real order statuses (rule 8)', () => {
    for (const s of ORDER_REPEATABLE_STATUSES) expect(ORDER_STATUSES).toContain(s)
  })

  it('the contract parses each kind', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const d = priceDisplay({ pricePaise: 100000, discountBps: 0 })
    expect(buyAgainSchema.safeParse({ kind: 'package', orderId: id, title: 't', providerName: 'P', packageId: id, tier: null, displayThen: d, displayNow: d, priceChanged: false, href: `/app/checkout/${id}` }).success).toBe(true)
    expect(buyAgainSchema.safeParse({ kind: 'similar', orderId: id, title: 't', providerName: null, searchHref: '/app/search?service=gst-filing' }).success).toBe(true)
    expect(buyAgainSchema.safeParse({ kind: 'repeat', orderId: id, title: 't', providerName: 'P', rfqId: id, href: repeatRequirementHref(id) }).success).toBe(true)
  })
})

describe('E9 FR-9.4 completeness card dismissal', () => {
  it('hides for 7 days, then shows again', () => {
    const now = Date.parse('2026-09-23T00:00:00Z')
    const until = dismissUntil(now)
    expect(until - now).toBe(HOME_DISMISS_DAYS * 86_400_000)
    expect(isDismissed(String(until), now + 6 * 86_400_000)).toBe(true)
    expect(isDismissed(String(until), now + 7 * 86_400_000)).toBe(false)
    expect(isDismissed(null, now)).toBe(false)
    expect(isDismissed('garbage', now)).toBe(false)
  })
})
