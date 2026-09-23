import { describe, expect, it } from 'vitest'
import { ORDER_STATUSES, ORDER_THREAD_OPEN_DAYS, orderIsActive, orderMessageSchema, orderThreadState, redactContactInfo } from '../index'

const DAY = 86_400_000
const now = Date.parse('2026-09-23T12:00:00Z')

describe('E8b FR-8.4 — order threads', () => {
  it('open on every active status, whatever the dates', () => {
    for (const s of ORDER_STATUSES.filter((x) => orderIsActive(x))) expect(orderThreadState({ status: s, completedAt: null, updatedAt: null, now })).toBe('open')
  })
  it('after completion: open for 30 days, then read-only', () => {
    const at = (d: number) => new Date(now - d * DAY).toISOString()
    expect(orderThreadState({ status: 'completed', completedAt: at(ORDER_THREAD_OPEN_DAYS - 1), updatedAt: null, now })).toBe('open')
    expect(orderThreadState({ status: 'completed', completedAt: at(ORDER_THREAD_OPEN_DAYS + 1), updatedAt: null, now })).toBe('read_only')
    expect(orderThreadState({ status: 'resolved_release', completedAt: null, updatedAt: at(3), now })).toBe('open')
    expect(orderThreadState({ status: 'refunded', completedAt: null, updatedAt: at(45), now })).toBe('read_only')
    expect(orderThreadState({ status: 'cancelled_by_buyer', completedAt: null, updatedAt: null, now })).toBe('read_only')
  })
  it('the body schema is strict and bounded; masking is the quote-thread rule', () => {
    expect(orderMessageSchema.safeParse({ body: '  ' }).success).toBe(false)
    expect(orderMessageSchema.safeParse({ body: 'ok', sender_id: 'x' }).success).toBe(false)
    expect(orderMessageSchema.safeParse({ body: 'ok', documentIds: ['11111111-1111-4111-8111-111111111111'] }).success).toBe(true)
    const m = redactContactInfo('Call 9876543210 or mail a@b.co')
    expect(m.redacted).toBe(true)
    expect(m.text).not.toContain('9876543210')
    expect(m.text).not.toContain('a@b.co')
  })
})
