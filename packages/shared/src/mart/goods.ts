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
  /** Null for a spec-goods line quoted without a listing (M2 goods RFQ). */
  product_id: z.string().uuid().nullable(),
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
  /** Mart category of the line — set for listing-less lines so the release gate can find its return window. */
  category_slug: z.string().max(60).optional(),
  /** E16 N42 — a sample: qty 1 at the listing's sample price (an ordinary goods order otherwise). */
  sample: z.boolean().optional(),
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
  /** E16 N42 — one listing, qty 1, at its sample price (the route refuses anything else). */
  sample: z.boolean().optional(),
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

// ── M2: goods RFQ (MART_DESIGN.md §7 M2 — bulk/spec goods through the
// existing RFQ + quote flow with kind='goods') ────────────────────────────────

export const GOODS_RFQ_MAX_SPEC_LINES = 12

/** rfqs.goods_spec — what the buyer needs, in goods terms (no services template). */
export const goodsRfqSpecSchema = z.object({
  item: z.string().trim().min(3).max(140),
  qty: z.number().int().positive().max(10_000_000),
  unit: productUnitSchema,
  /** Spec rows the seller must meet ([{k, v}], seller-readable). */
  spec: z.array(z.object({ k: z.string().trim().min(1).max(40), v: z.string().trim().min(1).max(200) })).max(GOODS_RFQ_MAX_SPEC_LINES).default([]),
  brand_preference: z.string().trim().max(80).optional(),
  /** Buyer's target unit price (paise) — a signal to sellers, never a cap. */
  target_unit_price_paise: z.number().int().positive().optional(),
  /** Delivery snapshot the eventual goods order carries (same shape as checkout). */
  delivery: z.object({
    contact_name: z.string().trim().min(2).max(100),
    contact_phone: z.string().regex(/^(?:\+91)?[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
    address: z.string().trim().min(5).max(300),
    city: z.string().trim().min(2).max(80),
    state: z.string().min(2).max(4),
    pincode: z.string().regex(/^\d{6}$/),
    pickup: z.boolean().default(false),
  }),
  /** Listing the request started from (product page "Ask for a bulk quote"), if any. */
  product_id: z.string().uuid().optional(),
})
export type GoodsRfqSpec = z.infer<typeof goodsRfqSpecSchema>

/**
 * Audit M4 — what a matched seller sees of a goods request before any order
 * exists: WHERE it goes (city, state, pincode, pickup), never WHO or the street
 * address. The contact reaches the seller on the goods order's delivery
 * snapshot, after the buyer pays.
 */
export function goodsSpecForSeller(spec: unknown): Record<string, unknown> | null {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null
  const s = spec as Record<string, unknown>
  const d = s['delivery']
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ...s }
  const hidden = new Set(['contact_name', 'contact_phone', 'address'])
  const where = Object.fromEntries(Object.entries(d as Record<string, unknown>).filter(([k]) => !hidden.has(k)))
  return { ...s, delivery: where }
}

/**
 * Goods quote terms. The seller states a UNIT price (excl. GST) at the RFQ's
 * quantity plus the tax facts the order needs; the server computes
 * price_paise = qty × unit price and never trusts a client total.
 */
export const goodsQuoteTermsSchema = z.object({
  unit_price_paise: z.number().int().positive(),
  gst_rate_bps: gstRateBpsSchema,
  hsn_code: hsnCodeSchema,
  /** The seller's own listing this quote is for (prefills name/HSN; links the order line). */
  product_id: z.string().uuid().optional(),
  /** Seller can offer a different quantity (MOQ / pack rounding); default = the RFQ's qty. */
  qty: z.number().int().positive().max(10_000_000).optional(),
})
export type GoodsQuoteTerms = z.infer<typeof goodsQuoteTermsSchema>

/** Line item for a goods order born from a quote (no listing required). */
export function goodsQuoteLineItem(input: { spec: GoodsRfqSpec; terms: GoodsQuoteTerms; productName?: string | null; categorySlug: string }): GoodsLineItem {
  const qty = input.terms.qty ?? input.spec.qty
  const taxable = qty * input.terms.unit_price_paise
  return {
    product_id: input.terms.product_id ?? null,
    name: input.productName ?? input.spec.item,
    unit: input.spec.unit,
    qty,
    tier_min_qty: qty,
    tier_unit_price_paise: input.terms.unit_price_paise,
    hsn_code: input.terms.hsn_code,
    gst_rate_bps: input.terms.gst_rate_bps,
    line_taxable_paise: taxable,
    line_gst_paise: Math.round((taxable * input.terms.gst_rate_bps) / 10000),
    category_slug: input.categorySlug,
  }
}
