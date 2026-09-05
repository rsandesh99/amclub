/**
 * AMC Mart — goods orders (MART_DESIGN.md §4.3).
 *
 * Line-item snapshot shape, tier resolution, server-side goods money math,
 * ITC display helper, the goods order_events vocabulary, and the goods payout
 * release gate. All money is integer paise; all rounding is explicit here so
 * checkout, the order row, the invoice and the payout dossier agree to the
 * paisa. Clients NEVER compute totals (FRONTEND.md §8) — they display these.
 */
import { z } from 'zod'
import { hsnCodeSchema, gstRateBpsSchema, productUnitSchema } from './catalog'

// ── Line items ───────────────────────────────────────────────────────────────

/** orders.line_items / checkout_sessions.line_items element (frozen at checkout). */
export const goodsLineItemSchema = z.object({
  product_id: z.string().uuid(),
  /** Display snapshot so the order stays readable if the listing changes. */
  name: z.string().min(1).max(140),
  unit: productUnitSchema,
  qty: z.number().int().positive(),
  tier_min_qty: z.number().int().positive(),
  tier_unit_price_paise: z.number().int().positive(),
  hsn_code: hsnCodeSchema,
  gst_rate_bps: gstRateBpsSchema,
  /** qty × tier_unit_price_paise (taxable). */
  line_taxable_paise: z.number().int().nonnegative(),
  /** GST on this line at its own rate (goods carry mixed slabs). */
  line_gst_paise: z.number().int().nonnegative(),
})
export type GoodsLineItem = z.infer<typeof goodsLineItemSchema>

/** Cart → checkout request body. Prices are NOT accepted from the client. */
export const goodsCheckoutSchema = z.object({
  items: z
    .array(z.object({ product_id: z.string().uuid(), qty: z.number().int().positive().max(1_000_000) }))
    .min(1)
    .max(20),
  delivery: z.object({
    contact_name: z.string().trim().min(2).max(100),
    contact_phone: z.string().regex(/^(?:\+91)?[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
    address: z.string().trim().min(5).max(300),
    city: z.string().trim().min(2).max(80),
    state: z.string().min(2).max(4),
    pincode: z.string().regex(/^\d{6}$/),
    /** Buyer picks up from the seller (cluster radius) instead of delivery. */
    pickup: z.boolean().default(false),
  }),
  gstInvoice: z
    .object({ gstin: z.string().optional(), businessName: z.string().optional(), address: z.string().optional() })
    .optional(),
  idempotencyKey: z.string().uuid(),
})
export type GoodsCheckoutInput = z.infer<typeof goodsCheckoutSchema>

// ── Tier resolution ──────────────────────────────────────────────────────────

export interface PriceTier {
  min_qty: number
  unit_price_paise: number
}

/** The tier whose min_qty is the largest value ≤ qty (tiers need not be sorted). */
export function resolveTier<T extends PriceTier>(tiers: readonly T[], qty: number): T | null {
  let best: T | null = null
  for (const t of tiers) {
    if (t.min_qty <= qty && (best === null || t.min_qty > best.min_qty)) best = t
  }
  return best
}

// ── Money math ───────────────────────────────────────────────────────────────

export interface GoodsLineInput {
  qty: number
  unitPricePaise: number
  gstRateBps: number
  /** Per-line commission (category-specific); falls back to the order-level bps. */
  commissionBps?: number
}

export interface GoodsLineAmounts {
  taxablePaise: number
  gstPaise: number
}

export interface GoodsOrderAmounts {
  /** Sum of line taxable values (= orders.price_paise; no listing discount on goods). */
  pricePaise: number
  discountPaise: 0
  taxablePaise: number
  /** Sum of per-line GST (each line at its own slab). */
  gstPaise: number
  totalPaise: number
  commissionBps: number
  commissionPaise: number
  providerEarningPaise: number
  lines: GoodsLineAmounts[]
}

/**
 * Compute every goods money column. Mirrors computeOrderAmounts' split
 * (commission on taxable; GST on top; seller earns taxable − commission) so
 * payout.ts, the fee-headroom guard and invoices work unchanged for kind='goods'.
 * GST and commission are rounded PER LINE (mixed slabs / mixed category
 * commissions), then summed — invoices print lines.
 */
export function computeGoodsOrderAmounts(input: { lines: GoodsLineInput[]; commissionBps: number }): GoodsOrderAmounts {
  if (input.lines.length === 0) throw new Error('computeGoodsOrderAmounts: no lines')
  const lines: GoodsLineAmounts[] = input.lines.map((l) => {
    if (!Number.isInteger(l.qty) || l.qty <= 0) throw new Error('computeGoodsOrderAmounts: qty must be a positive integer')
    if (!Number.isInteger(l.unitPricePaise) || l.unitPricePaise <= 0) throw new Error('computeGoodsOrderAmounts: unit price must be positive paise')
    const taxablePaise = l.qty * l.unitPricePaise
    const gstPaise = Math.round((taxablePaise * l.gstRateBps) / 10000)
    return { taxablePaise, gstPaise }
  })
  const taxablePaise = lines.reduce((s, l) => s + l.taxablePaise, 0)
  const gstPaise = lines.reduce((s, l) => s + l.gstPaise, 0)
  // Commission is rounded PER LINE too (mixed categories may carry different
  // bps); with one uniform bps this equals the order-level rounding to ±1 paisa.
  const commissionPaise = input.lines.reduce(
    (s, l, i) => s + Math.round((lines[i]!.taxablePaise * (l.commissionBps ?? input.commissionBps)) / 10000),
    0,
  )
  return {
    pricePaise: taxablePaise,
    discountPaise: 0,
    taxablePaise,
    gstPaise,
    totalPaise: taxablePaise + gstPaise,
    commissionBps: input.commissionBps,
    commissionPaise,
    providerEarningPaise: taxablePaise - commissionPaise,
    lines,
  }
}

/**
 * ITC display (§2): for a GST-registered buyer the GST paid is an input credit,
 * so the effective cost is the taxable value. Pure presentation helper — the
 * server computes it and the client displays it (never re-derives).
 */
export function effectiveCostAfterItcPaise(amounts: { taxablePaise: number }): number {
  return amounts.taxablePaise
}

// ── Goods order events (extension of the order_events vocabulary) ────────────

export const GOODS_ORDER_EVENTS = [
  'dispatched',
  'delivered_photo',
  'buyer_received',
  'return_opened',
  'return_resolved',
] as const
export type GoodsOrderEvent = (typeof GOODS_ORDER_EVENTS)[number]

/** Goods order actions (mapped to §3.7 transitions in the API, never repurposed). */
export const GOODS_ORDER_ACTIONS = ['accept', 'dispatch', 'deliver', 'accept_delivery', 'open_return', 'cancel'] as const
export type GoodsOrderAction = (typeof GOODS_ORDER_ACTIONS)[number]

/** Dispatch payload — e-way-bill data fields captured now, generator later (§2). */
export const goodsDispatchSchema = z.object({
  dispatch_photo_doc_id: z.string().uuid(),
  /** Inbound seller invoice (recorded against the order) — number + optional photo. */
  seller_invoice_number: z.string().trim().min(1).max(60),
  seller_invoice_doc_id: z.string().uuid().optional(),
  batch_or_lot: z.string().trim().max(60).optional(),
  transporter_name: z.string().trim().max(120).optional(),
  vehicle_number: z.string().trim().max(20).optional(),
  eway_bill_number: z.string().trim().regex(/^\d{12}$/).optional(),
})
export type GoodsDispatchInput = z.infer<typeof goodsDispatchSchema>

export const goodsDeliverSchema = z.object({
  delivery_photo_doc_id: z.string().uuid(),
})

export const goodsReturnSchema = z.object({
  reason: z.enum(['damaged', 'wrong_item', 'short_quantity', 'quality', 'other']),
  details: z.string().trim().max(1000).optional(),
  photo_doc_id: z.string().uuid().optional(),
})

// ── Release gate ─────────────────────────────────────────────────────────────

/** Buyer receipt auto-accept window after the delivery photo (same 72h as services). */
export const GOODS_AUTO_ACCEPT_HOURS = 72

export type GoodsHoldReason = 'no_delivery_photo' | 'awaiting_receipt' | 'return_window_open' | 'return_open'

export interface GoodsReleaseFacts {
  deliveredPhotoAt: Date | null
  buyerReceivedAt: Date | null
  returnOpenedAt: Date | null
  returnResolvedAt: Date | null
  returnWindowHours: number
  now: Date
}

export interface GoodsReleaseGate {
  ok: boolean
  reasons: GoodsHoldReason[]
  /** When the return window closes (null until there is delivery evidence). */
  returnWindowEndsAt: Date | null
  /** When auto-receipt would fire (null until there is delivery evidence). */
  autoReceiptAt: Date | null
}

const HOUR_MS = 3600 * 1000

/**
 * MART_DESIGN.md §4.3: release only when
 *   (buyer_received OR 72h auto-accept after delivered_photo) AND the
 *   per-category return window is clear AND no return is open.
 * Pure: the caller (payout dossier / schedulePayout) supplies facts from
 * order_events. Never releases money itself.
 */
export function evaluateGoodsReleaseGate(f: GoodsReleaseFacts): GoodsReleaseGate {
  const reasons: GoodsHoldReason[] = []
  const evidenceAt = f.deliveredPhotoAt ?? f.buyerReceivedAt
  if (!f.deliveredPhotoAt) reasons.push('no_delivery_photo')

  const autoReceiptAt = f.deliveredPhotoAt ? new Date(f.deliveredPhotoAt.getTime() + GOODS_AUTO_ACCEPT_HOURS * HOUR_MS) : null
  const received = !!f.buyerReceivedAt || (autoReceiptAt !== null && f.now.getTime() >= autoReceiptAt.getTime())
  if (f.deliveredPhotoAt && !received) reasons.push('awaiting_receipt')

  const returnWindowEndsAt = evidenceAt ? new Date(evidenceAt.getTime() + f.returnWindowHours * HOUR_MS) : null
  if (returnWindowEndsAt && f.now.getTime() < returnWindowEndsAt.getTime()) reasons.push('return_window_open')

  if (f.returnOpenedAt && !(f.returnResolvedAt && f.returnResolvedAt.getTime() >= f.returnOpenedAt.getTime())) {
    reasons.push('return_open')
  }

  return { ok: reasons.length === 0, reasons, returnWindowEndsAt, autoReceiptAt }
}
