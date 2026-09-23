import type { OrderStatus } from './state-machines'

/**
 * N23 (PRD Experience v3, FR-8.1) — the ONE rule for "what happens next on
 * this order, who does it, and by when". Used by the nav badges and home
 * action lists (N2 / N25), the order page's NextStepBar (E8) and notification
 * copy. Reads statuses only from `state-machines.ts` (rule 8) and never
 * decides legality: `applyTransition` still enforces every move.
 */

/** Hours a provider has to accept a placed order before it auto-cancels (cron `auto-cancel`). */
export const ORDER_ACCEPT_WINDOW_HOURS = 24
/** Hours a buyer has to review a delivery before it auto-accepts (`deliver` sets auto_accept_at). */
export const ORDER_AUTO_ACCEPT_HOURS = 72

export type OrderRole = 'buyer' | 'provider'

export const NEXT_ACTIONS = [
  'accept_order',
  'share_requirements',
  'start_work',
  'deliver_work',
  'review_delivery',
  'resume_work',
  'leave_review',
  'dispute_statement',
  'wait_provider_accept',
  'wait_requirements',
  'wait_start',
  'wait_delivery',
  'wait_acceptance',
  'wait_revision',
  'wait_government',
  'wait_dispute',
] as const
export type NextActionKey = (typeof NEXT_ACTIONS)[number]

/** What happens if the deadline passes (a message key suffix; null = nothing automatic). */
export type NextActionConsequence = 'auto_cancel_refund' | 'auto_accept' | null

export interface NextActionFacts {
  /** orders.created_at — the 24 h accept clock starts here. */
  createdAt: string
  /** orders.due_at — the delivery deadline. */
  dueAt?: string | null
  /** orders.auto_accept_at — set on deliver. */
  autoAcceptAt?: string | null
  /** orders.external_wait_since — the provider is waiting on a government portal. */
  externalWaitSince?: string | null
  /** Services only; goods orders follow the Mart action set. */
  kind?: 'service' | 'goods'
  /** Disputed orders: has THIS party filed its statement (S1.7)? */
  ownStatementSubmitted?: boolean
}

export interface NextAction {
  action: NextActionKey
  /** 'self' = the viewer must act (counts toward badges); 'other' = waiting on the other party / the system. */
  actor: 'self' | 'other'
  /** ISO deadline, when there is one. */
  dueAt: string | null
  consequence: NextActionConsequence
}

const HOUR = 3600 * 1000
const plusHours = (iso: string, h: number) => new Date(Date.parse(iso) + h * HOUR).toISOString()

export function nextAction(status: OrderStatus | string, role: OrderRole, facts: NextActionFacts): NextAction | null {
  if (facts.kind === 'goods') return null
  const buyer = role === 'buyer'
  const self = (action: NextActionKey, dueAt: string | null = null, consequence: NextActionConsequence = null): NextAction => ({ action, actor: 'self', dueAt, consequence })
  const other = (action: NextActionKey, dueAt: string | null = null, consequence: NextActionConsequence = null): NextAction => ({ action, actor: 'other', dueAt, consequence })

  switch (status as OrderStatus) {
    case 'placed': {
      const by = plusHours(facts.createdAt, ORDER_ACCEPT_WINDOW_HOURS)
      return buyer ? other('wait_provider_accept', by, 'auto_cancel_refund') : self('accept_order', by, 'auto_cancel_refund')
    }
    case 'accepted':
      return buyer ? self('share_requirements') : other('wait_requirements')
    case 'requirements_submitted':
      return buyer ? other('wait_start', facts.dueAt ?? null) : self('start_work', facts.dueAt ?? null)
    case 'in_progress':
      if (facts.externalWaitSince) return other('wait_government')
      return buyer ? other('wait_delivery', facts.dueAt ?? null) : self('deliver_work', facts.dueAt ?? null)
    case 'delivered':
      return buyer
        ? self('review_delivery', facts.autoAcceptAt ?? null, 'auto_accept')
        : other('wait_acceptance', facts.autoAcceptAt ?? null, 'auto_accept')
    case 'revision_requested':
      return buyer ? other('wait_revision', facts.dueAt ?? null) : self('resume_work', facts.dueAt ?? null)
    case 'completed':
      return buyer ? self('leave_review') : null
    case 'disputed':
      return facts.ownStatementSubmitted ? other('wait_dispute') : self('dispute_statement')
    default:
      // reviewed, resolved_*, refunded, cancelled_*, auto_cancelled — nothing left to do.
      return null
  }
}
