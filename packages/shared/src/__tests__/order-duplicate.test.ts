import { describe, it, expect } from 'vitest'
import { ORDER_STATUSES, ORDER_TRANSITIONS, DISPUTABLE_STATUSES, PAYOUT_RELEASE_STATUSES, isValidOrderTransition } from '../state-machines'
import { computeRefundPaise } from '../money'
import { orderIsActive } from '../support'

describe('ADR-014 §7 (H6) — cancelled_duplicate', () => {
  it('is reachable only from placed, and leads only to refunded', () => {
    const into = ORDER_STATUSES.filter((s) => ORDER_TRANSITIONS[s].includes('cancelled_duplicate'))
    expect(into).toEqual(['placed'])
    expect(ORDER_TRANSITIONS.cancelled_duplicate).toEqual(['refunded'])
    expect(isValidOrderTransition('accepted', 'cancelled_duplicate')).toBe(false)
  })

  it('existing meanings are untouched: auto_cancelled and cancelled_by_buyer keep their own edges', () => {
    expect(ORDER_TRANSITIONS.placed).toEqual(['accepted', 'auto_cancelled', 'cancelled_by_buyer', 'cancelled_duplicate'])
    expect(ORDER_TRANSITIONS.auto_cancelled).toEqual(['refunded'])
    expect(ORDER_TRANSITIONS.cancelled_by_buyer).toEqual(['refunded'])
  })

  it('is never disputable, never releases a payout, and is not an active order', () => {
    expect(DISPUTABLE_STATUSES.includes('cancelled_duplicate')).toBe(false)
    expect(PAYOUT_RELEASE_STATUSES.includes('cancelled_duplicate')).toBe(false)
    expect(orderIsActive('cancelled_duplicate')).toBe(false)
  })

  it('the refund is the full total (computed from placed, the status it was cancelled from)', () => {
    expect(computeRefundPaise({ totalPaise: 23_600_00, fromStatus: 'placed' })).toBe(23_600_00)
  })
})
