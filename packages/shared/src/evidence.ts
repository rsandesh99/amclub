import { z } from 'zod'
import { uuidSchema } from './schemas/index'

/**
 * Services evidence engine (BUILD_PROMPTS S0.3). A services order moves stage by
 * stage with photo proof — accepted → reached site / materials procured → work
 * in progress → work complete — and the payout release gate reads this evidence
 * exactly as the goods gate reads delivery photos. Pure machine + gate here; the
 * route/lib supply facts from order_milestones. This is the data the S1.4
 * Payout-Evidence agent consumes.
 */

export const MILESTONE_KINDS = ['accepted', 'site_or_materials', 'in_progress', 'work_complete'] as const
export type MilestoneKind = (typeof MILESTONE_KINDS)[number]
export const milestoneKindSchema = z.enum(MILESTONE_KINDS)

/** Ordered: each kind at most once, added in this order. */
export const MILESTONE_ORDER: Record<MilestoneKind, number> = {
  accepted: 0,
  site_or_materials: 1,
  in_progress: 2,
  work_complete: 3,
}

/** Kinds that MUST carry a photo (the accepted check-in may be photoless). */
export const MILESTONE_PHOTO_REQUIRED: MilestoneKind[] = ['site_or_materials', 'in_progress', 'work_complete']

/** Order statuses during which a milestone may be added. */
export const MILESTONE_OPEN_STATUSES = ['accepted', 'requirements_submitted', 'in_progress'] as const

export const milestoneSchema = z
  .object({
    kind: milestoneKindSchema,
    note: z.string().max(500).optional(),
    photo_doc_id: uuidSchema.optional(),
  })
  .superRefine((d, ctx) => {
    if (MILESTONE_PHOTO_REQUIRED.includes(d.kind) && !d.photo_doc_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['photo_doc_id'], message: `A photo is required for the ${d.kind} milestone` })
    }
  })
export type MilestoneInput = z.infer<typeof milestoneSchema>

/** The next milestone kind to capture, given the ones already recorded (or null when done). */
export function nextMilestoneKind(existing: readonly MilestoneKind[]): MilestoneKind | null {
  const have = new Set(existing)
  for (const k of MILESTONE_KINDS) if (!have.has(k)) return k
  return null
}

export type MilestoneReject = 'out_of_order' | 'duplicate' | 'order_not_open'

/**
 * Can this milestone be added now? In order, no duplicate, and only while the
 * order is in an open working status. Returns the rejection reason otherwise.
 */
export function canAddMilestone(
  existing: readonly MilestoneKind[],
  kind: MilestoneKind,
  orderStatus: string,
): { ok: true } | { ok: false; reason: MilestoneReject } {
  if (!(MILESTONE_OPEN_STATUSES as readonly string[]).includes(orderStatus)) return { ok: false, reason: 'order_not_open' }
  if (existing.includes(kind)) return { ok: false, reason: 'duplicate' }
  if (nextMilestoneKind(existing) !== kind) return { ok: false, reason: 'out_of_order' }
  return { ok: true }
}

// ── Release gate ──────────────────────────────────────────────────────────────

export type ServicesHoldReason = 'missing_work_complete_photo' | 'awaiting_buyer_confirmation' | 'dispute_open'

export interface ServicesReleaseFacts {
  milestones: { kind: MilestoneKind; photo_doc_id: string | null }[]
  /** When the buyer accepted delivery (or the 72h auto-accept fired); null if not yet. */
  buyerConfirmedAt: Date | null
  disputeOpen: boolean
}

export interface ServicesReleaseGate {
  ok: boolean
  reasons: ServicesHoldReason[]
}

/**
 * Release only when the work-complete photo exists AND the buyer has confirmed
 * (their tap or the 72h auto-accept) AND no dispute is open. Pure; never moves
 * money. Mirrors evaluateGoodsReleaseGate (mart/goods.ts §4.3).
 */
export function evaluateServicesReleaseGate(f: ServicesReleaseFacts): ServicesReleaseGate {
  const reasons: ServicesHoldReason[] = []
  const workComplete = f.milestones.find((m) => m.kind === 'work_complete')
  if (!workComplete || !workComplete.photo_doc_id) reasons.push('missing_work_complete_photo')
  if (!f.buyerConfirmedAt) reasons.push('awaiting_buyer_confirmation')
  if (f.disputeOpen) reasons.push('dispute_open')
  return { ok: reasons.length === 0, reasons }
}
