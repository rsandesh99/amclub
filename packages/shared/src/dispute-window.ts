// ADR-014 (H2) — who may raise a dispute on a SERVICES order, and until when.
// Before completion: any status in DISPUTABLE_STATUSES (each has a → disputed
// edge). After completion: only inside `dispute_window_days` from completion.
// Goods orders never use this: their returns follow the Mart category window.

import { DISPUTABLE_STATUSES, ORDER_TRANSITIONS, type OrderStatus } from './state-machines'

const DAY_MS = 24 * 60 * 60 * 1000

/** When a completed order stops accepting a dispute (ISO), or null without a completion time. */
export function disputeWindowEndsAt(completedAt: string | null | undefined, windowDays: number): string | null {
  if (!completedAt) return null
  const t = Date.parse(completedAt)
  if (!Number.isFinite(t)) return null
  return new Date(t + windowDays * DAY_MS).toISOString()
}

export type RaiseDisputeCheck = { ok: true } | { ok: false; reason: 'status' } | { ok: false; reason: 'window_closed'; endsAt: string | null }

/**
 * The one rule the server enforces and the clients mirror. `completedAt` is the
 * moment the order completed; a completed order without one is treated as
 * closed (fail safe on money).
 */
export function canRaiseDispute(p: {
  status: OrderStatus
  completedAt: string | null | undefined
  windowDays: number
  now?: number
}): RaiseDisputeCheck {
  const next = ORDER_TRANSITIONS[p.status] ?? []
  if (!DISPUTABLE_STATUSES.includes(p.status) || !next.includes('disputed')) return { ok: false, reason: 'status' }
  if (p.status !== 'completed') return { ok: true }
  const endsAt = disputeWindowEndsAt(p.completedAt, p.windowDays)
  if (!endsAt || (p.now ?? Date.now()) >= Date.parse(endsAt)) return { ok: false, reason: 'window_closed', endsAt }
  return { ok: true }
}
