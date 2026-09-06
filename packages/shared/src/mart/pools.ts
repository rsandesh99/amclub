/**
 * AMC Mart — group-buy pool state machine (MART_DESIGN.md §4.4). Built in M0
 * as pure code so M1 (tables + agent + payments) lands on a tested machine.
 * Exhaustive transitions; illegal transitions THROW; every transition emits
 * a pool_events row (the API does the emitting, this file names the vocabulary).
 */

export const POOL_STATUSES = ['open', 'closed_met', 'closed_unmet', 'ordered', 'fulfilled', 'cancelled'] as const
export type PoolStatus = (typeof POOL_STATUSES)[number]

export const POOL_TRANSITIONS: Record<PoolStatus, readonly PoolStatus[]> = {
  open: ['closed_met', 'closed_unmet', 'cancelled'],
  closed_met: ['ordered', 'cancelled'],
  closed_unmet: [],
  ordered: ['fulfilled'],
  fulfilled: [],
  cancelled: [],
}

export class PoolTransitionError extends Error {
  constructor(
    public readonly from: PoolStatus,
    public readonly to: PoolStatus,
  ) {
    super(`Illegal pool transition ${from} → ${to}`)
    this.name = 'PoolTransitionError'
  }
}

export function isValidPoolTransition(from: PoolStatus, to: PoolStatus): boolean {
  return (POOL_TRANSITIONS[from] as readonly string[]).includes(to)
}

/** Throws PoolTransitionError on an illegal move; returns `to` otherwise. */
export function assertPoolTransition(from: PoolStatus, to: PoolStatus): PoolStatus {
  if (!isValidPoolTransition(from, to)) throw new PoolTransitionError(from, to)
  return to
}

/** pool_members.payment_state — UPI block-and-capture lifecycle (§4.4). */
export const POOL_MEMBER_PAYMENT_STATES = ['blocked', 'captured', 'released', 'failed'] as const
export type PoolMemberPaymentState = (typeof POOL_MEMBER_PAYMENT_STATES)[number]

export const POOL_MEMBER_PAYMENT_TRANSITIONS: Record<PoolMemberPaymentState, readonly PoolMemberPaymentState[]> = {
  blocked: ['captured', 'released', 'failed'],
  captured: [],
  released: [],
  // A failed capture may be retried (re-block) — never silently captured.
  failed: ['blocked'],
}

export function isValidPoolMemberPaymentTransition(from: PoolMemberPaymentState, to: PoolMemberPaymentState): boolean {
  return (POOL_MEMBER_PAYMENT_TRANSITIONS[from] as readonly string[]).includes(to)
}

/**
 * The one money rule of pools, as a pure predicate: blocked funds may be
 * captured ONLY when the pool closed met. Killtested in M1 ("blocked funds
 * NEVER captured on unmet pools").
 */
export function mayCapturePoolMember(pool: PoolStatus, member: PoolMemberPaymentState): boolean {
  return pool === 'closed_met' && member === 'blocked'
}

/** Decide the close outcome from committed quantity vs the minimum. */
export function poolCloseOutcome(committedQty: number, minQty: number): Extract<PoolStatus, 'closed_met' | 'closed_unmet'> {
  return committedQty >= minQty ? 'closed_met' : 'closed_unmet'
}

/** pool_events.event_type vocabulary. */
export const POOL_EVENT_TYPES = [
  'created',
  'opened',
  'joined',
  'left',
  'closed_met',
  'closed_unmet',
  'ordered',
  'fulfilled',
  'cancelled',
  'capture_attempted',
  'captured',
  'capture_failed',
  'released',
] as const
export type PoolEventType = (typeof POOL_EVENT_TYPES)[number]
