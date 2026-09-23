import { ORDER_TRANSITIONS, DISPUTABLE_STATUSES, type OrderStatus } from '@amclub/shared'

/**
 * Which order actions a party is OFFERED in the services workspace, derived
 * from the shared §3.7 machine (ORDER_TRANSITIONS + DISPUTABLE_STATUSES) — the
 * same inputs the server's ACTION_RULES (lib/orders/transitions.ts) check. The
 * server stays the authority; this only decides which buttons to render.
 */
export type OrderActionKey =
  | 'accept'
  | 'submit_requirements'
  | 'start'
  | 'deliver'
  | 'accept_delivery'
  | 'request_revision'
  | 'resume'
  | 'cancel'
  | 'raise_dispute'

type Role = 'msme' | 'provider'

interface ActionDef {
  action: OrderActionKey
  role: Role
  /** Target status in the shared machine. */
  to: OrderStatus
  /** Only where two actions share a target (start / resume → in_progress). */
  from?: OrderStatus
}

const IN_PROGRESS: OrderStatus = 'in_progress'
const DISPUTED: OrderStatus = 'disputed'

const ACTION_DEFS: readonly ActionDef[] = [
  { action: 'accept', role: 'provider', to: 'accepted' },
  { action: 'start', role: 'provider', to: IN_PROGRESS, from: 'requirements_submitted' },
  { action: 'deliver', role: 'provider', to: 'delivered' },
  { action: 'resume', role: 'provider', to: IN_PROGRESS, from: 'revision_requested' },
  { action: 'submit_requirements', role: 'msme', to: 'requirements_submitted' },
  { action: 'accept_delivery', role: 'msme', to: 'completed' },
  { action: 'request_revision', role: 'msme', to: 'revision_requested' },
  { action: 'cancel', role: 'msme', to: 'cancelled_by_buyer' },
]

export function actionsFor(
  role: Role,
  status: string,
  opts: { revisionsLeft: number },
): OrderActionKey[] {
  const s = status as OrderStatus
  const next = ORDER_TRANSITIONS[s] ?? []
  const out = ACTION_DEFS.filter(
    (d) => d.role === role && next.includes(d.to) && (!d.from || d.from === s),
  )
    .map((d) => d.action)
    // The server rejects a revision once revision_used >= revision_max.
    .filter((a) => a !== 'request_revision' || opts.revisionsLeft > 0)
  // Raising a dispute: the buyer's "report a problem" (the server allows either
  // party). The server checks BOTH lists — DISPUTABLE_STATUSES (the rule) and
  // isValidOrderTransition(from, 'disputed') — so offer only their intersection.
  if (role === 'msme' && DISPUTABLE_STATUSES.includes(s) && next.includes(DISPUTED)) out.push('raise_dispute')
  return out
}

/** Actions that need an explicit confirm sheet (irreversible or money-moving). */
export const CONFIRM_ACTIONS: ReadonlySet<OrderActionKey> = new Set<OrderActionKey>([
  'accept',
  'deliver',
  'accept_delivery',
  'request_revision',
  'cancel',
  'raise_dispute',
])

/** Actions whose confirm sheet collects a short reason (sent to the transition route). */
export const REASON_ACTIONS: ReadonlySet<OrderActionKey> = new Set<OrderActionKey>(['request_revision', 'raise_dispute'])
export const REASON_MIN = 10
export const REASON_MAX = 1000
