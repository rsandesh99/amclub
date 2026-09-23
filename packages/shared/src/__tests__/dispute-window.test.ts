import { describe, it, expect } from 'vitest'
import { canRaiseDispute, disputeWindowEndsAt } from '../dispute-window'
import { DISPUTABLE_STATUSES, ORDER_STATUSES, ORDER_TRANSITIONS, isValidOrderTransition, type OrderStatus } from '../state-machines'
import { AGENT_SETTING_DEFS } from '../agent-settings'

const DAY = 24 * 60 * 60 * 1000
const completedAt = '2026-09-01T10:00:00.000Z'
const done = Date.parse(completedAt)

describe('ADR-014 H2 — every disputable status can actually reach disputed', () => {
  it('each DISPUTABLE_STATUSES entry has a → disputed edge (the bug: accepted / requirements_submitted had none)', () => {
    for (const s of DISPUTABLE_STATUSES) expect(isValidOrderTransition(s, 'disputed')).toBe(true)
  })

  it('every status before completion after the provider accepts is disputable (§3.7 any-pre-completed)', () => {
    for (const s of ['accepted', 'requirements_submitted', 'in_progress', 'delivered', 'revision_requested'] as const) {
      expect(canRaiseDispute({ status: s, completedAt: null, windowDays: 7 })).toEqual({ ok: true })
    }
  })

  it('placed is not disputable (the buyer cancels with a full refund instead); terminal states never are', () => {
    for (const s of ['placed', 'disputed', 'resolved_refund', 'resolved_release', 'resolved_partial', 'auto_cancelled', 'cancelled_by_buyer', 'refunded', 'reviewed'] as const) {
      expect(canRaiseDispute({ status: s, completedAt, windowDays: 7, now: done })).toEqual({ ok: false, reason: 'status' })
    }
  })

  it('the edges added are the only change: nothing else gained a → disputed edge', () => {
    const withEdge = ORDER_STATUSES.filter((s) => ORDER_TRANSITIONS[s].includes('disputed'))
    expect(withEdge.sort()).toEqual([...DISPUTABLE_STATUSES].sort())
  })
})

describe('ADR-014 H2 — the post-completion window', () => {
  it('disputeWindowEndsAt adds whole days to completion', () => {
    expect(disputeWindowEndsAt(completedAt, 7)).toBe('2026-09-08T10:00:00.000Z')
    expect(disputeWindowEndsAt(null, 7)).toBeNull()
    expect(disputeWindowEndsAt('not a date', 7)).toBeNull()
  })

  it('open until the last millisecond, closed from the deadline on', () => {
    const at = (ms: number) => canRaiseDispute({ status: 'completed', completedAt, windowDays: 7, now: done + ms })
    expect(at(0)).toEqual({ ok: true })
    expect(at(7 * DAY - 1)).toEqual({ ok: true })
    expect(at(7 * DAY)).toEqual({ ok: false, reason: 'window_closed', endsAt: '2026-09-08T10:00:00.000Z' })
    expect(at(30 * DAY)).toMatchObject({ ok: false, reason: 'window_closed' })
  })

  it('a completed order with no completion time is closed (fail safe)', () => {
    expect(canRaiseDispute({ status: 'completed', completedAt: null, windowDays: 7 })).toEqual({ ok: false, reason: 'window_closed', endsAt: null })
  })

  it('the window never applies before completion', () => {
    const s: OrderStatus = 'delivered'
    expect(canRaiseDispute({ status: s, completedAt, windowDays: 1, now: done + 365 * DAY })).toEqual({ ok: true })
  })

  it('dispute_window_days is a registered setting: default 7, 1..90 days', () => {
    const def = AGENT_SETTING_DEFS.dispute_window_days
    expect(def.default).toBe(7)
    expect(def.schema.safeParse(7).success).toBe(true)
    expect(def.schema.safeParse(0).success).toBe(false)
    expect(def.schema.safeParse(91).success).toBe(false)
    expect(def.schema.safeParse(2.5).success).toBe(false)
  })
})
