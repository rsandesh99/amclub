import { describe, expect, it } from 'vitest'
import { nextAction, NEXT_ACTIONS, ORDER_ACCEPT_WINDOW_HOURS } from '../order-next-action'
import { ORDER_STATUSES, ORDER_TRANSITIONS } from '../state-machines'

const facts = { createdAt: '2026-09-23T10:00:00.000Z', dueAt: '2026-09-30T10:00:00.000Z', autoAcceptAt: '2026-09-26T10:00:00.000Z' }

describe('nextAction (N23) — every status × role', () => {
  for (const status of ORDER_STATUSES) {
    for (const role of ['buyer', 'provider'] as const) {
      it(`${status} / ${role}`, () => {
        const a = nextAction(status, role, facts)
        const terminal = ORDER_TRANSITIONS[status].length === 0
        if (terminal) expect(a).toBeNull()
        if (a) expect(NEXT_ACTIONS).toContain(a.action)
      })
    }
  }

  it('exactly one party acts on every live, non-terminal status (except completed for providers)', () => {
    for (const status of ORDER_STATUSES) {
      if (ORDER_TRANSITIONS[status].length === 0) continue
      if (['auto_cancelled', 'cancelled_by_buyer', 'cancelled_duplicate'].includes(status)) continue
      const b = nextAction(status, 'buyer', facts)
      const p = nextAction(status, 'provider', facts)
      if (status === 'completed') { expect(b?.actor).toBe('self'); expect(p).toBeNull(); continue }
      if (status === 'disputed') continue // both file statements
      expect([b?.actor, p?.actor].filter((x) => x === 'self')).toHaveLength(1)
    }
  })

  it('placed: the provider must accept within 24 h or the buyer is refunded', () => {
    const p = nextAction('placed', 'provider', facts)!
    expect(p).toMatchObject({ action: 'accept_order', actor: 'self', consequence: 'auto_cancel_refund' })
    expect(Date.parse(p.dueAt!) - Date.parse(facts.createdAt)).toBe(ORDER_ACCEPT_WINDOW_HOURS * 3600 * 1000)
    expect(nextAction('placed', 'buyer', facts)).toMatchObject({ action: 'wait_provider_accept', actor: 'other' })
  })

  it('delivered: the buyer reviews by auto_accept_at, or it is accepted for them', () => {
    expect(nextAction('delivered', 'buyer', facts)).toEqual({ action: 'review_delivery', actor: 'self', dueAt: facts.autoAcceptAt, consequence: 'auto_accept' })
  })

  it('a government-portal wait pauses the provider’s delivery action', () => {
    expect(nextAction('in_progress', 'provider', { ...facts, externalWaitSince: '2026-09-24T00:00:00Z' })).toMatchObject({ action: 'wait_government', actor: 'other' })
  })

  it('disputes: each party files its own statement once', () => {
    expect(nextAction('disputed', 'buyer', facts)).toMatchObject({ action: 'dispute_statement', actor: 'self' })
    expect(nextAction('disputed', 'buyer', { ...facts, ownStatementSubmitted: true })).toMatchObject({ action: 'wait_dispute', actor: 'other' })
  })

  it('goods orders are out of scope (Mart action set)', () => {
    expect(nextAction('accepted', 'buyer', { ...facts, kind: 'goods' })).toBeNull()
  })
})
