import { z } from 'zod'
import type { ReturnFreightPayer } from './settings'

/**
 * E16 N41 — seller promises, opted into per product (products.promises, staged
 * 0069), and N43 — non-returnable / ITC-ineligible categories. Pure rules; the
 * server measures breaches and filters badges, clients only render.
 *
 * Promises never touch money or the release gate: `evaluateGoodsReleaseGate`
 * is unchanged, and a breach only removes the buyer-facing badge.
 */
export const MART_PROMISES = ['ships_48h', 'return_shipping_covered', 'gst_invoice_24h'] as const
export type MartPromise = (typeof MART_PROMISES)[number]

export const martPromisesSchema = z
  .array(z.enum(MART_PROMISES))
  .max(MART_PROMISES.length)
  .refine((a) => new Set(a).size === a.length, { message: 'duplicate promise' })
  .default([])

/** The promises measured from order timestamps. "Return shipping covered" is enforced, not measured (see effectiveReturnFreightPayer). */
export const MEASURED_PROMISES = ['ships_48h', 'gst_invoice_24h'] as const satisfies readonly MartPromise[]

const HOUR = 3_600_000
export const SHIPS_WITHIN_HOURS = 48
export const INVOICE_WITHIN_HOURS = 24

export interface PromiseTimeline {
  /** The goods order was placed (paid) — orders.created_at. */
  placedAt: string
  /** First dispatch photo on the order (order_documents.created_at, kind dispatch_photo). */
  dispatchPhotoAt: string | null
  /** The 'dispatched' order event. */
  dispatchedAt: string | null
  /** The seller's invoice document named at dispatch (seller_invoice_doc_id), when there is one. */
  invoiceDocAt: string | null
}

export interface PromiseBreach {
  promise: MartPromise
  detail: { reason: 'late' | 'missing'; hours_late?: number; deadline: string }
}

/**
 * Which of this product's measured promises the order broke, as of `now`.
 *  ships_48h        the first dispatch photo is on the order within 48 h of placement
 *                   (no photo once 48 h have passed = breach).
 *  gst_invoice_24h  the seller's invoice document is on the order within 24 h of the
 *                   dispatch photo (dispatched without one, once 24 h pass = breach).
 * A promise with its deadline still ahead is never a breach.
 */
export function measurePromiseBreaches(promises: readonly string[], t: PromiseTimeline, now: Date): PromiseBreach[] {
  const out: PromiseBreach[] = []
  const late = (at: string, deadline: number) => Math.ceil((Date.parse(at) - deadline) / HOUR)
  if (promises.includes('ships_48h')) {
    const deadline = Date.parse(t.placedAt) + SHIPS_WITHIN_HOURS * HOUR
    const iso = new Date(deadline).toISOString()
    if (t.dispatchPhotoAt) {
      if (Date.parse(t.dispatchPhotoAt) > deadline) out.push({ promise: 'ships_48h', detail: { reason: 'late', hours_late: late(t.dispatchPhotoAt, deadline), deadline: iso } })
    } else if (now.getTime() > deadline) {
      out.push({ promise: 'ships_48h', detail: { reason: 'missing', deadline: iso } })
    }
  }
  const dispatchAt = t.dispatchPhotoAt ?? t.dispatchedAt
  if (promises.includes('gst_invoice_24h') && dispatchAt) {
    const deadline = Date.parse(dispatchAt) + INVOICE_WITHIN_HOURS * HOUR
    const iso = new Date(deadline).toISOString()
    if (t.invoiceDocAt) {
      if (Date.parse(t.invoiceDocAt) > deadline) out.push({ promise: 'gst_invoice_24h', detail: { reason: 'late', hours_late: late(t.invoiceDocAt, deadline), deadline: iso } })
    } else if (now.getTime() > deadline) {
      out.push({ promise: 'gst_invoice_24h', detail: { reason: 'missing', deadline: iso } })
    }
  }
  return out
}

/** mart_settings `promise_breach_limit` default: 3 breaches of one promise in 90 days removes its badge. */
export const DEFAULT_PROMISE_BREACH_LIMIT = { count: 3, window_days: 90 } as const
export const promiseBreachLimitSchema = z.object({ count: z.number().int().min(1).max(20), window_days: z.number().int().min(7).max(365) })
export type PromiseBreachLimit = z.infer<typeof promiseBreachLimitSchema>

/** The badges a buyer sees: the opted-in promises minus any with `limit.count` or more breaches in the window. */
export function activePromiseBadges(promises: readonly string[], breaches: Partial<Record<string, number>>, limit: Pick<PromiseBreachLimit, 'count'>): MartPromise[] {
  return MART_PROMISES.filter((p) => promises.includes(p) && (breaches[p] ?? 0) < limit.count)
}

/**
 * "Return shipping covered" makes the seller bear return freight on that
 * product whatever the category says (§9.2 config stays the default).
 */
export function effectiveReturnFreightPayer(categoryPayer: ReturnFreightPayer, promises: readonly string[]): ReturnFreightPayer {
  return promises.includes('return_shipping_covered') ? 'seller' : categoryPayer
}

/**
 * N43 — a non-returnable category refuses returns for quality / other reasons.
 * Damaged, wrong and short deliveries are the seller's fault and are always
 * claimable, returnable or not.
 */
export const ALWAYS_CLAIMABLE_RETURN_REASONS = ['damaged', 'wrong_item', 'short_quantity'] as const
export function returnAllowed(returnable: boolean, reason: string): boolean {
  return returnable || (ALWAYS_CLAIMABLE_RETURN_REASONS as readonly string[]).includes(reason)
}

/**
 * N43 — the ITC a GST-registered buyer can claim: the GST of the lines whose
 * category is ITC-eligible (the CA-reviewed §17(5) flag). The effective cost is
 * the total minus that credit. With every line eligible this is exactly the
 * taxable value (the pre-E16 display).
 */
export function goodsItcSplit(lines: readonly { gstPaise: number; itcEligible: boolean }[], totalPaise: number): { itcPaise: number; afterItcPaise: number } {
  const itcPaise = lines.reduce((s, l) => s + (l.itcEligible ? l.gstPaise : 0), 0)
  return { itcPaise, afterItcPaise: totalPaise - itcPaise }
}
