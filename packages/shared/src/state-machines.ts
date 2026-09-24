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
  // ADR-014 §7 (H6): a second paid order on an already-accepted RFQ, cancelled and
  // refunded in full by the system. Its own state, so auto_cancelled keeps
  // meaning "the provider never accepted" and cancelled_by_buyer "the buyer chose".
  'cancelled_duplicate',
] as const

export type OrderStatus = (typeof ORDER_STATUSES)[number]

/**
 * Maps each status to the set of statuses it can legally transition TO.
 * The actor who may perform each transition is enforced in the API middleware —
 * this map is purely about what transitions are structurally valid.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  placed: ['accepted', 'auto_cancelled', 'cancelled_by_buyer', 'cancelled_duplicate'],
  // ADR-014 (H2): accepted / requirements_submitted / revision_requested → disputed
  // are §3.7's "any-pre-completed → disputed" — edges the map had been missing,
  // so a buyer whose provider accepted and went silent had no exit.
  accepted: ['requirements_submitted', 'cancelled_by_buyer', 'disputed'],
  requirements_submitted: ['in_progress', 'disputed'],
  in_progress: ['delivered', 'disputed'],
  delivered: ['completed', 'revision_requested', 'disputed'],
  revision_requested: ['in_progress', 'disputed'],
  completed: ['reviewed', 'disputed'],
  disputed: ['resolved_refund', 'resolved_release', 'resolved_partial'],
  resolved_refund: [],
  resolved_release: [],
  resolved_partial: [],
  auto_cancelled: ['refunded'],
  cancelled_by_buyer: ['refunded'],
  refunded: [],
  reviewed: [],
  cancelled_duplicate: ['refunded'],
}

/** Statuses from which a dispute may be raised: every status after the provider
 *  accepts and before completion (§3.7), plus `completed` inside the
 *  post-completion window (`dispute_window_days`, shared `dispute-window.ts`).
 *  Every entry has a `→ disputed` edge in ORDER_TRANSITIONS (a tested invariant). */
export const DISPUTABLE_STATUSES: readonly OrderStatus[] = [
  'accepted',
  'requirements_submitted',
  'in_progress',
  'delivered',
  'revision_requested',
  'completed',
]

/** Work in flight: paid, not yet completed or closed, and not in dispute (dashboards, "active orders"). */
export const ORDER_IN_FLIGHT_STATUSES: readonly OrderStatus[] = [
  'placed',
  'accepted',
  'requirements_submitted',
  'in_progress',
  'delivered',
  'revision_requested',
]

/** Finished by acceptance: `reviewed` is a completed order the buyer went on to review. */
export const ORDER_DONE_STATUSES: readonly OrderStatus[] = ['completed', 'reviewed']

/** Paid orders that were cancelled or refunded before delivery — not a buyer's
 *  lasting choice (Experience v3 FR-4.6 "Most chosen" leaves them out). */
export const ORDER_UNCHOSEN_STATUSES: readonly OrderStatus[] = ['auto_cancelled', 'cancelled_by_buyer', 'cancelled_duplicate', 'refunded']

/** E9 (FR-9.3) — a finished order the buyer can buy again / repeat: completed, with or without a review. */
export const ORDER_REPEATABLE_STATUSES: readonly OrderStatus[] = ['completed', 'reviewed']

/** E9b (FR-9.5) — a provider may record the certificate issued on a registration order from the work stage on. */
export const ORDER_LICENCE_RECORDABLE_STATUSES: readonly OrderStatus[] = ['in_progress', 'delivered', 'revision_requested', 'completed', 'reviewed']

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

/** Live requirements: still collecting or choosing quotes (dashboards, "open requirements"). */
export const RFQ_LIVE_STATUSES: readonly RfqStatus[] = ['open', 'quoted']

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
 * Named quote statuses, so a route guards on `.eq('status', QUOTE_STATUS.submitted)`
 * instead of a bare literal (rule 8). Mirrors QUOTE_STATUSES one-to-one.
 */
export const QUOTE_STATUS = {
  submitted: 'submitted',
  withdrawn: 'withdrawn',
  accepted: 'accepted',
  declined: 'declined',
  expired: 'expired',
} as const satisfies { [K in QuoteStatus]: K }

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

/** Named payout statuses (rule 8), mirroring PAYOUT_STATUSES one-to-one. */
export const PAYOUT_STATUS = {
  scheduled: 'scheduled',
  processing: 'processing',
  paid: 'paid',
  failed: 'failed',
  held: 'held',
} as const satisfies { [K in PayoutStatus]: K }

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

// ── Procurement session (S3.1) ────────────────────────────────────────────────
// One buyer need followed by the procurement agent. drafting → awaiting_create
// (the create_rfq proposal is out) → quality (S1.5 held for answers) | live
// (fanned out) → quotes_in → chosen (the buyer tapped "go with" — a checkout
// LINK was sent; nothing is paid here) → closed (the RFQ was accepted, expired or
// cancelled, or the buyer said no). expired = the session TTL lapsed; failed =
// the grant was revoked or the agent switched off. Terminal states are final.

export const PROCUREMENT_SESSION_STATES = ['drafting', 'awaiting_create', 'quality', 'live', 'quotes_in', 'chosen', 'closed', 'expired', 'failed'] as const
export type ProcurementSessionState = (typeof PROCUREMENT_SESSION_STATES)[number]

export const PROCUREMENT_SESSION_TRANSITIONS: Record<ProcurementSessionState, readonly ProcurementSessionState[]> = {
  drafting: ['awaiting_create', 'closed', 'expired', 'failed'],
  // back to drafting when the buyer edits / adds detail; quality or live once the create ran
  awaiting_create: ['drafting', 'quality', 'live', 'closed', 'expired', 'failed'],
  quality: ['live', 'closed', 'expired', 'failed'],
  live: ['quotes_in', 'closed', 'expired', 'failed'],
  quotes_in: ['chosen', 'closed', 'expired', 'failed'],
  // the buyer may choose again (a different quote, or after declining) until the RFQ closes
  chosen: ['quotes_in', 'closed', 'expired', 'failed'],
  closed: [],
  expired: [],
  failed: [],
}

export const PROCUREMENT_SESSION_TERMINAL: readonly ProcurementSessionState[] = ['closed', 'expired', 'failed']

export function isValidProcurementSessionTransition(from: ProcurementSessionState, to: ProcurementSessionState): boolean {
  return (PROCUREMENT_SESSION_TRANSITIONS[from] as readonly string[]).includes(to)
}

export function procurementSessionIsActive(state: string): boolean {
  return (PROCUREMENT_SESSION_STATES as readonly string[]).includes(state) && !(PROCUREMENT_SESSION_TERMINAL as readonly string[]).includes(state)
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
