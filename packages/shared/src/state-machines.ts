/**
 * Canonical state machines for AMClub order pipeline.
 * §3.7 — these are the ONLY valid status values and transitions.
 * The API rejects any transition not listed here.
 * Never define status string literals anywhere else in the codebase.
 */

// ── Order ─────────────────────────────────────────────────────────────────────

export const ORDER_STATUSES = [
  'placed',
  'accepted',
  'requirements_submitted',
  'in_progress',
  'delivered',
  'revision_requested',
  'completed',
  'disputed',
  'resolved_refund',
  'resolved_release',
  'resolved_partial',
  'auto_cancelled',
  'cancelled_by_buyer',
  'refunded',
  'reviewed',
] as const

export type OrderStatus = (typeof ORDER_STATUSES)[number]

/**
 * Maps each status to the set of statuses it can legally transition TO.
 * The actor who may perform each transition is enforced in the API middleware —
 * this map is purely about what transitions are structurally valid.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  placed: ['accepted', 'auto_cancelled', 'cancelled_by_buyer'],
  accepted: ['requirements_submitted', 'cancelled_by_buyer'],
  requirements_submitted: ['in_progress'],
  in_progress: ['delivered', 'disputed'],
  delivered: ['completed', 'revision_requested', 'disputed'],
  revision_requested: ['in_progress'],
  completed: ['reviewed', 'disputed'],
  disputed: ['resolved_refund', 'resolved_release', 'resolved_partial'],
  resolved_refund: [],
  resolved_release: [],
  resolved_partial: [],
  auto_cancelled: ['refunded'],
  cancelled_by_buyer: ['refunded'],
  refunded: [],
  reviewed: [],
}

/** Pre-completion statuses from which a dispute may be raised (§3.7). */
export const DISPUTABLE_STATUSES: readonly OrderStatus[] = [
  'accepted',
  'requirements_submitted',
  'in_progress',
  'delivered',
  'completed',
]

/** Statuses from which a payout is permitted (§3.7). */
export const PAYOUT_RELEASE_STATUSES: readonly OrderStatus[] = [
  'completed',
  'resolved_release',
  'resolved_partial',
]

export function isValidOrderTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (ORDER_TRANSITIONS[from] as readonly string[]).includes(to)
}

// ── RFQ ───────────────────────────────────────────────────────────────────────

export const RFQ_STATUSES = ['open', 'quoted', 'accepted', 'expired', 'cancelled'] as const
export type RfqStatus = (typeof RFQ_STATUSES)[number]

export const RFQ_TRANSITIONS: Record<RfqStatus, readonly RfqStatus[]> = {
  open: ['quoted', 'expired', 'cancelled'],
  quoted: ['accepted', 'expired', 'cancelled'],
  accepted: [],
  expired: [],
  cancelled: [],
}

export function isValidRfqTransition(from: RfqStatus, to: RfqStatus): boolean {
  return (RFQ_TRANSITIONS[from] as readonly string[]).includes(to)
}

// ── Quote ─────────────────────────────────────────────────────────────────────

export const QUOTE_STATUSES = [
  'submitted',
  'withdrawn',
  'accepted',
  'declined',
  'expired',
] as const
export type QuoteStatus = (typeof QUOTE_STATUSES)[number]

/**
 * S1.2 — the ONE quote transition map (rule 8). It codifies what the code
 * already did: a submitted quote is accepted by the paid checkout, declined by
 * the buyer (new route) or by finalizeQuoteAcceptance (system), withdrawn by
 * the provider, or expired by the cron. Every other state is terminal — there
 * is no declined → submitted.
 */
export const QUOTE_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  submitted: ['accepted', 'declined', 'withdrawn', 'expired'],
  accepted: [],
  declined: [],
  withdrawn: [],
  expired: [],
}

export function canTransitionQuote(from: QuoteStatus, to: QuoteStatus): boolean {
  return (QUOTE_TRANSITIONS[from] as readonly string[]).includes(to)
}

// ── Payout ────────────────────────────────────────────────────────────────────

export const PAYOUT_STATUSES = ['scheduled', 'processing', 'paid', 'failed', 'held'] as const
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number]

export const PAYOUT_TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> = {
  scheduled: ['processing', 'held'],
  processing: ['paid', 'failed', 'held'],
  paid: [],
  failed: ['scheduled'],
  held: ['scheduled'],
}

export function isValidPayoutTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  return (PAYOUT_TRANSITIONS[from] as readonly string[]).includes(to)
}

// ── Agent run (H0 groundwork, ADR-008) ────────────────────────────────────────
// One run = one agent task on behalf of one user. `awaiting_confirmation` is
// the confirm-gate: a tool marked `confirm: true` (see agent.ts) parks the run
// until the SURFACE (never the model) records the user's explicit yes/no.

export const AGENT_RUN_STATUSES = [
  'running',
  'awaiting_confirmation',
  'completed',
  'failed',
  'cancelled',
] as const
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number]

export const AGENT_RUN_TRANSITIONS: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
  running: ['awaiting_confirmation', 'completed', 'failed', 'cancelled'],
  awaiting_confirmation: ['running', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
}

export function isValidAgentRunTransition(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return (AGENT_RUN_TRANSITIONS[from] as readonly string[]).includes(to)
}
