import { describe, expect, it } from 'vitest'
import { GOLD_THREAD_STEPS, NEXT_ACTIONS, ORDER_STATUSES, PAYOUT_STATUSES, goldThread, nextAction, nextStepTarget, parseOrderTab, providerMoneyLine, visibleOrderTabs } from '../index'

describe('E8 FR-8.3 — tabs', () => {
  it('unknown → overview; messages only while messaging is on', () => {
    expect(parseOrderTab('work', { messagesOn: false })).toBe('work')
    expect(parseOrderTab('nope', { messagesOn: true })).toBe('overview')
    expect(parseOrderTab(null, { messagesOn: true })).toBe('overview')
    expect(parseOrderTab('messages', { messagesOn: false })).toBe('overview')
    expect(parseOrderTab('messages', { messagesOn: true })).toBe('messages')
    expect(visibleOrderTabs({ messagesOn: false })).not.toContain('messages')
    expect(visibleOrderTabs({ messagesOn: true })).toEqual(['overview', 'requirements', 'work', 'messages', 'documents', 'timeline'])
  })
})

describe('E8 FR-8.2 — every next step has a target or is a wait', () => {
  it('self actions point somewhere; waits have no button', () => {
    for (const a of NEXT_ACTIONS) {
      const target = nextStepTarget(a)
      if (a.startsWith('wait_')) expect(target).toBeNull()
      else expect(target).not.toBeNull()
    }
  })
  it('every (status × role) the bar can show resolves (the nextAction table stays the one rule)', () => {
    for (const status of ORDER_STATUSES) {
      for (const role of ['buyer', 'provider'] as const) {
        const n = nextAction(status, role, { createdAt: '2026-09-23T00:00:00Z' })
        if (n?.actor === 'self') expect(nextStepTarget(n.action)).not.toBeNull()
      }
    }
  })
})

describe('E8 — the Gold Thread', () => {
  it('status alone, events push it forward, never backward', () => {
    expect(goldThread('placed', [])).toEqual({ reached: 0, branch: null })
    expect(goldThread('in_progress', ['placed', 'accept', 'submit_requirements', 'start'])).toEqual({ reached: 2, branch: null })
    expect(goldThread('completed', [])).toEqual({ reached: 4, branch: null })
    expect(goldThread('disputed', ['placed', 'accept', 'submit_requirements', 'start', 'deliver'])).toEqual({ reached: 3, branch: 'disputed' })
    expect(goldThread('refunded', ['placed', 'auto_cancelled'])).toEqual({ reached: 0, branch: 'refunded' })
    expect(goldThread('resolved_release', ['placed', 'accept'])).toEqual({ reached: 1, branch: 'resolved' })
  })
  it('covers every status and stays in range', () => {
    for (const s of ORDER_STATUSES) {
      const g = goldThread(s, [])
      expect(g.reached).toBeGreaterThanOrEqual(0)
      expect(g.reached).toBeLessThan(GOLD_THREAD_STEPS.length)
    }
  })
})

describe('E8 FR-8.5 (N37) — the provider money line', () => {
  const base = { scheduledFor: '2026-10-05', paidAt: null, holdReasons: [] as string[] }
  it('secured while active with no payout row; nothing once cancelled or refunded', () => {
    expect(providerMoneyLine({ status: 'in_progress', totalPaise: 353_882, payout: null })).toEqual({ kind: 'secured', amountPaise: 353_882 })
    expect(providerMoneyLine({ status: 'disputed', totalPaise: 1, payout: null })).toEqual({ kind: 'secured', amountPaise: 1 })
    expect(providerMoneyLine({ status: 'refunded', totalPaise: 1, payout: null })).toBeNull()
    expect(providerMoneyLine({ status: 'cancelled_by_buyer', totalPaise: 1, payout: null })).toBeNull()
  })
  it('a payout row speaks for itself: scheduled date, paid, held with de-duplicated reasons', () => {
    expect(providerMoneyLine({ status: 'completed', totalPaise: 1, payout: { status: 'scheduled', ...base } })).toEqual({ kind: 'scheduled', date: '2026-10-05' })
    expect(providerMoneyLine({ status: 'completed', totalPaise: 1, payout: { status: 'paid', ...base, paidAt: '2026-10-05T10:00:00Z' } })).toEqual({ kind: 'paid', date: '2026-10-05T10:00:00Z' })
    expect(providerMoneyLine({ status: 'disputed', totalPaise: 1, payout: { status: 'held', ...base, holdReasons: ['dispute_open', 'dispute_open'] } })).toEqual({ kind: 'held', reasons: ['dispute_open'] })
    for (const s of PAYOUT_STATUSES) expect(providerMoneyLine({ status: 'completed', totalPaise: 1, payout: { status: s, ...base } })?.kind).toBeTruthy()
  })
})
