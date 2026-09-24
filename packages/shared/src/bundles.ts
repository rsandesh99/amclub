import { z } from 'zod'
import type { OrderAmounts } from './money'

/**
 * ADR 021 (PRD Experience v3 E12c, N18) — compliance bundles with milestone
 * escrow. A bundle is a package with milestones (seq, label, due offset, share).
 * ONE payment creates one ordinary child order per milestone; each child runs
 * the ordinary state machine and pays out after its own completion, so the
 * payout rule is untouched. Everything here is deterministic money math; the
 * split is computed ONCE at checkout and frozen on the session.
 */
export const MAX_BUNDLE_MILESTONES = 6
export const MIN_BUNDLE_MILESTONES = 2
/** v1: at most ~3 months prepaid (RBI PA / Route hold questions for longer — see ADR 021). */
export const MAX_BUNDLE_DAYS = 92
export const MIN_SHARE_BPS = 100

const label = z.string().trim().min(1).max(60)
export const bundleMilestoneInputSchema = z
  .object({
    label_i18n: z.object({ en: label, hi: label.optional(), te: label.optional(), ta: label.optional() }).strict(),
    due_offset_days: z.number().int().min(1).max(MAX_BUNDLE_DAYS),
    share_bps: z.number().int().min(MIN_SHARE_BPS).max(10000),
  })
  .strict()
export type BundleMilestoneInput = z.infer<typeof bundleMilestoneInputSchema>

export type BundleProblem = 'shares_not_10000' | 'offsets_not_increasing'
export const bundleMilestonesSchema = z
  .array(bundleMilestoneInputSchema)
  .min(MIN_BUNDLE_MILESTONES)
  .max(MAX_BUNDLE_MILESTONES)
  .superRefine((ms, ctx) => {
    for (const p of bundleProblems(ms)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: p })
  })

/** Shares sum to exactly 10,000 bps; due offsets strictly increase (milestones are in order). */
export function bundleProblems(ms: readonly { due_offset_days: number; share_bps: number }[]): BundleProblem[] {
  const out: BundleProblem[] = []
  if (ms.reduce((s, m) => s + m.share_bps, 0) !== 10000) out.push('shares_not_10000')
  if (ms.some((m, i) => i > 0 && m.due_offset_days <= ms[i - 1]!.due_offset_days)) out.push('offsets_not_increasing')
  return out
}

/** A milestone row as the server reads it (ordered by seq). */
export interface BundleMilestoneRow {
  seq: number
  label_i18n: { en: string; hi?: string | null; te?: string | null; ta?: string | null }
  due_offset_days: number
  share_bps: number
}

export interface BundleChildPlan {
  seq: number
  label: { en: string; hi?: string; te?: string; ta?: string }
  /** Days after purchase the milestone becomes actionable (the previous milestone's due; 0 for the first). */
  startsOffsetDays: number
  dueOffsetDays: number
  /** dueOffset − startsOffset (≥ 1): the child order's delivery_days. */
  deliveryDays: number
  amounts: Omit<OrderAmounts, 'commissionBps' | 'taxablePaise'> & { taxablePaise: number }
}

/** Floor split of an integer by bps; the LAST part takes the remainder, so the parts sum exactly. */
export function splitByShares(total: number, sharesBps: readonly number[]): number[] {
  const parts = sharesBps.map((b) => Math.floor((total * b) / 10000))
  parts[parts.length - 1] = total - parts.slice(0, -1).reduce((s, x) => s + x, 0)
  return parts
}

/**
 * The frozen plan: one child per milestone. Price, discount, GST and commission
 * are split by share (remainder to the last); taxable, total and earning are
 * derived per child, so every child is internally consistent AND every column
 * sums exactly to the whole (Σ totals = the captured payment).
 */
export function bundlePlan(whole: OrderAmounts, milestones: readonly BundleMilestoneRow[]): BundleChildPlan[] {
  const ms = [...milestones].sort((a, b) => a.seq - b.seq)
  const shares = ms.map((m) => m.share_bps)
  const price = splitByShares(whole.pricePaise, shares)
  const discount = splitByShares(whole.discountPaise, shares)
  const gst = splitByShares(whole.gstPaise, shares)
  const commission = splitByShares(whole.commissionPaise, shares)
  return ms.map((m, i) => {
    const taxable = price[i]! - discount[i]!
    const startsOffsetDays = i === 0 ? 0 : ms[i - 1]!.due_offset_days
    return {
      seq: m.seq,
      label: {
        en: m.label_i18n.en,
        ...(m.label_i18n.hi ? { hi: m.label_i18n.hi } : {}),
        ...(m.label_i18n.te ? { te: m.label_i18n.te } : {}),
        ...(m.label_i18n.ta ? { ta: m.label_i18n.ta } : {}),
      },
      startsOffsetDays,
      dueOffsetDays: m.due_offset_days,
      deliveryDays: Math.max(1, m.due_offset_days - startsOffsetDays),
      amounts: {
        pricePaise: price[i]!,
        discountPaise: discount[i]!,
        taxablePaise: taxable,
        gstPaise: gst[i]!,
        totalPaise: taxable + gst[i]!,
        commissionPaise: commission[i]!,
        providerEarningPaise: taxable - commission[i]!,
      },
    }
  })
}

/** The session snapshot (checkout_sessions.bundle_plan) — what the materialisation trigger copies, never recomputes. */
export const bundlePlanSnapshotSchema = z.object({
  v: z.literal(1),
  children: z.array(
    z.object({
      seq: z.number().int().min(1),
      label: z.object({ en: z.string(), hi: z.string().optional(), te: z.string().optional(), ta: z.string().optional() }),
      startsOffsetDays: z.number().int().min(0),
      dueOffsetDays: z.number().int().min(1),
      deliveryDays: z.number().int().min(1),
      amounts: z.object({
        pricePaise: z.number().int(),
        discountPaise: z.number().int(),
        taxablePaise: z.number().int(),
        gstPaise: z.number().int(),
        totalPaise: z.number().int(),
        commissionPaise: z.number().int(),
        providerEarningPaise: z.number().int(),
      }),
    }),
  ).min(MIN_BUNDLE_MILESTONES).max(MAX_BUNDLE_MILESTONES),
})
export type BundlePlanSnapshot = z.infer<typeof bundlePlanSnapshotSchema>

export function bundlePlanSnapshot(children: BundleChildPlan[]): BundlePlanSnapshot {
  return { v: 1, children: children.map((c) => ({ seq: c.seq, label: c.label, startsOffsetDays: c.startsOffsetDays, dueOffsetDays: c.dueOffsetDays, deliveryDays: c.deliveryDays, amounts: c.amounts })) }
}

/** A child is "unstarted" (cancellable with a full refund) while it is placed or accepted — the existing policy (100 %). */
export const BUNDLE_UNSTARTED_STATUSES = ['placed', 'accepted'] as const
export function isUnstartedChild(status: string): boolean {
  return (BUNDLE_UNSTARTED_STATUSES as readonly string[]).includes(status)
}
