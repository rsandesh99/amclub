import type { NextActionKey } from './order-next-action'
import type { OrderStatus, PayoutStatus } from './state-machines'
import { orderIsActive } from './support'

/**
 * PRD Experience v3 E8 — the order workspace v3 (flag `orders`). Pure rules
 * the web page, mobile and the rig share: which tab a URL opens, where the
 * order sits on the Gold Thread, and the provider's money line (N37). Every
 * status comes from `state-machines.ts` (rule 8) through typed maps.
 */

// ── FR-8.3 section tabs ─────────────────────────────────────────────────────────────
export const ORDER_TABS = ['overview', 'requirements', 'work', 'messages', 'documents', 'timeline'] as const
export type OrderTab = (typeof ORDER_TABS)[number]

/** `?tab=` → a tab; unknown or (while messaging is off) `messages` → overview. */
export function parseOrderTab(raw: string | null | undefined, opts: { messagesOn: boolean }): OrderTab {
  const t = (ORDER_TABS as readonly string[]).includes(raw ?? '') ? (raw as OrderTab) : 'overview'
  return t === 'messages' && !opts.messagesOn ? 'overview' : t
}

export function visibleOrderTabs(opts: { messagesOn: boolean }): OrderTab[] {
  return ORDER_TABS.filter((t) => t !== 'messages' || opts.messagesOn)
}

// ── FR-8.2 NextStepBar: what the one primary action does ───────────────────────────
/** The workspace action a next step triggers (`order-actions.ts` keys), or the tab that holds it. */
export type NextStepTarget = { kind: 'action'; action: 'accept' | 'start' | 'deliver' | 'accept_delivery' | 'resume' } | { kind: 'tab'; tab: OrderTab }

const NEXT_STEP_TARGET: Record<NextActionKey, NextStepTarget | null> = {
  accept_order: { kind: 'action', action: 'accept' },
  share_requirements: { kind: 'tab', tab: 'requirements' },
  start_work: { kind: 'action', action: 'start' },
  deliver_work: { kind: 'tab', tab: 'work' },
  review_delivery: { kind: 'action', action: 'accept_delivery' },
  resume_work: { kind: 'action', action: 'resume' },
  leave_review: { kind: 'tab', tab: 'overview' },
  dispute_statement: { kind: 'tab', tab: 'overview' },
  wait_provider_accept: null,
  wait_requirements: null,
  wait_start: null,
  wait_delivery: null,
  wait_acceptance: null,
  wait_revision: null,
  wait_government: null,
  wait_dispute: null,
}
export function nextStepTarget(action: NextActionKey): NextStepTarget | null {
  return NEXT_STEP_TARGET[action]
}

// ── The Gold Thread (Timeline) ───────────────────────────────────────────────────────
export const GOLD_THREAD_STEPS = ['paid', 'accepted', 'work', 'delivered', 'done'] as const
export type GoldThreadStep = (typeof GOLD_THREAD_STEPS)[number]
export type GoldThreadBranch = 'disputed' | 'cancelled' | 'refunded' | 'resolved' | null

/** Timeline events that move the thread forward (order_events.event). */
const STEP_OF_EVENT: Readonly<Record<string, number>> = {
  placed: 0,
  accept: 1,
  submit_requirements: 2,
  requirements_submitted: 2,
  start: 2,
  resume: 2,
  deliver: 3,
  accept_delivery: 4,
  auto_accepted: 4,
}

/** Where the status alone puts the thread (orders with no events yet, or events lost to a replay). */
const STEP_OF_STATUS: Record<OrderStatus, number> = {
  placed: 0,
  accepted: 1,
  requirements_submitted: 2,
  in_progress: 2,
  revision_requested: 2,
  delivered: 3,
  completed: 4,
  reviewed: 4,
  disputed: 0,
  resolved_refund: 0,
  resolved_release: 0,
  resolved_partial: 0,
  auto_cancelled: 0,
  cancelled_by_buyer: 0,
  cancelled_duplicate: 0,
  refunded: 0,
}

const BRANCH_OF_STATUS: Record<OrderStatus, GoldThreadBranch> = {
  placed: null,
  accepted: null,
  requirements_submitted: null,
  in_progress: null,
  revision_requested: null,
  delivered: null,
  completed: null,
  reviewed: null,
  disputed: 'disputed',
  resolved_refund: 'resolved',
  resolved_release: 'resolved',
  resolved_partial: 'resolved',
  auto_cancelled: 'cancelled',
  cancelled_by_buyer: 'cancelled',
  cancelled_duplicate: 'cancelled',
  refunded: 'refunded',
}

/** The furthest step reached (0-based) and, off the happy path, the branch the order took. */
export function goldThread(status: OrderStatus | string, eventNames: readonly string[]): { reached: number; branch: GoldThreadBranch } {
  const byStatus = STEP_OF_STATUS[status as OrderStatus] ?? 0
  const byEvents = eventNames.reduce((m, e) => Math.max(m, STEP_OF_EVENT[e] ?? -1), -1)
  return { reached: Math.max(byStatus, byEvents, 0), branch: BRANCH_OF_STATUS[status as OrderStatus] ?? null }
}

// ── FR-8.5 (N37) the provider's money line ───────────────────────────────────────────
export interface OrderPayoutFacts {
  status: PayoutStatus
  scheduledFor: string | null
  paidAt: string | null
  /** The latest payout_held event's reasons (only while held). */
  holdReasons: readonly string[]
}

export type ProviderMoneyLine =
  | { kind: 'secured'; amountPaise: number }
  | { kind: 'scheduled'; date: string | null }
  | { kind: 'processing' }
  | { kind: 'paid'; date: string | null }
  | { kind: 'held'; reasons: string[] }
  | { kind: 'failed' }

const PAYOUT_LINE: Record<PayoutStatus, (p: OrderPayoutFacts) => ProviderMoneyLine> = {
  scheduled: (p) => ({ kind: 'scheduled', date: p.scheduledFor }),
  processing: () => ({ kind: 'processing' }),
  paid: (p) => ({ kind: 'paid', date: p.paidAt }),
  failed: () => ({ kind: 'failed' }),
  held: (p) => ({ kind: 'held', reasons: [...new Set(p.holdReasons)] }),
}

/**
 * "Payment secured ✓ ₹X held by AMClub" while the order is active; once a
 * payout row exists, what it says (scheduled for / paid / on hold: reason).
 * Null when there is nothing to promise (cancelled, refunded, resolved to the
 * buyer). The amount is the server's order total — never computed here.
 */
export function providerMoneyLine(input: { status: OrderStatus | string; totalPaise: number; payout: OrderPayoutFacts | null }): ProviderMoneyLine | null {
  if (input.payout) return PAYOUT_LINE[input.payout.status](input.payout)
  return orderIsActive(input.status) ? { kind: 'secured', amountPaise: input.totalPaise } : null
}
