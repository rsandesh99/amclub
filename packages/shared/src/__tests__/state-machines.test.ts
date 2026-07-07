import { describe, it, expect } from 'vitest'
import {
  isValidOrderTransition,
  ORDER_TRANSITIONS,
  ORDER_STATUSES,
  PAYOUT_RELEASE_STATUSES,
  DISPUTABLE_STATUSES,
  isValidPayoutTransition,
  isValidRfqTransition,
} from '../state-machines'

describe('order state machine (§3.7)', () => {
  it('allows the canonical happy path', () => {
    expect(isValidOrderTransition('placed', 'accepted')).toBe(true)
    expect(isValidOrderTransition('accepted', 'requirements_submitted')).toBe(true)
    expect(isValidOrderTransition('requirements_submitted', 'in_progress')).toBe(true)
    expect(isValidOrderTransition('in_progress', 'delivered')).toBe(true)
    expect(isValidOrderTransition('delivered', 'completed')).toBe(true)
    expect(isValidOrderTransition('completed', 'reviewed')).toBe(true)
  })

  it('allows the revision loop within delivered → in_progress', () => {
    expect(isValidOrderTransition('delivered', 'revision_requested')).toBe(true)
    expect(isValidOrderTransition('revision_requested', 'in_progress')).toBe(true)
  })

  it('REJECTS the classic illegal jump: in_progress → completed', () => {
    expect(isValidOrderTransition('in_progress', 'completed')).toBe(false)
  })

  it('REJECTS provider skipping straight to completed from placed/accepted', () => {
    expect(isValidOrderTransition('placed', 'completed')).toBe(false)
    expect(isValidOrderTransition('accepted', 'completed')).toBe(false)
    expect(isValidOrderTransition('accepted', 'in_progress')).toBe(false)
  })

  it('cancellation + refund paths', () => {
    expect(isValidOrderTransition('placed', 'auto_cancelled')).toBe(true)
    expect(isValidOrderTransition('placed', 'cancelled_by_buyer')).toBe(true)
    expect(isValidOrderTransition('accepted', 'cancelled_by_buyer')).toBe(true)
    expect(isValidOrderTransition('auto_cancelled', 'refunded')).toBe(true)
    expect(isValidOrderTransition('cancelled_by_buyer', 'refunded')).toBe(true)
  })

  it('dispute resolutions are terminal (no further transitions)', () => {
    expect(isValidOrderTransition('disputed', 'resolved_refund')).toBe(true)
    expect(isValidOrderTransition('disputed', 'resolved_release')).toBe(true)
    expect(isValidOrderTransition('disputed', 'resolved_partial')).toBe(true)
    expect(ORDER_TRANSITIONS['resolved_refund']).toEqual([])
    expect(ORDER_TRANSITIONS['resolved_release']).toEqual([])
    expect(ORDER_TRANSITIONS['resolved_partial']).toEqual([])
  })

  it('every status is present in the transition map', () => {
    for (const s of ORDER_STATUSES) {
      expect(ORDER_TRANSITIONS[s]).toBeDefined()
    }
  })

  it('payout releases ONLY from completed / resolved_release / resolved_partial', () => {
    expect(PAYOUT_RELEASE_STATUSES).toEqual(['completed', 'resolved_release', 'resolved_partial'])
    expect(PAYOUT_RELEASE_STATUSES).not.toContain('delivered')
    expect(PAYOUT_RELEASE_STATUSES).not.toContain('in_progress')
  })

  it('disputes can be raised only from pre-completion + completed states', () => {
    expect(DISPUTABLE_STATUSES).toContain('in_progress')
    expect(DISPUTABLE_STATUSES).toContain('delivered')
    expect(DISPUTABLE_STATUSES).not.toContain('placed')
    expect(DISPUTABLE_STATUSES).not.toContain('refunded')
  })
})

describe('payout state machine', () => {
  it('scheduled → processing → paid; never paid → anything', () => {
    expect(isValidPayoutTransition('scheduled', 'processing')).toBe(true)
    expect(isValidPayoutTransition('processing', 'paid')).toBe(true)
    expect(isValidPayoutTransition('paid', 'processing')).toBe(false)
  })

  it('can hold from scheduled/processing and resume', () => {
    expect(isValidPayoutTransition('scheduled', 'held')).toBe(true)
    expect(isValidPayoutTransition('processing', 'held')).toBe(true)
    expect(isValidPayoutTransition('held', 'scheduled')).toBe(true)
  })
})

describe('rfq state machine', () => {
  it('canonical paths: open → quoted → accepted; open → expired/cancelled', () => {
    expect(isValidRfqTransition('open', 'quoted')).toBe(true)
    expect(isValidRfqTransition('quoted', 'accepted')).toBe(true)
    expect(isValidRfqTransition('open', 'expired')).toBe(true)
    expect(isValidRfqTransition('open', 'cancelled')).toBe(true)
    expect(isValidRfqTransition('quoted', 'expired')).toBe(true)
  })

  it('accepted/expired/cancelled are terminal', () => {
    expect(isValidRfqTransition('accepted', 'open')).toBe(false)
    expect(isValidRfqTransition('expired', 'open')).toBe(false)
    expect(isValidRfqTransition('cancelled', 'quoted')).toBe(false)
  })
})
