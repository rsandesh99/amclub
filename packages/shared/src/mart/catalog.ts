/**
 * AMC Mart — catalog vocabulary (MART_DESIGN.md §4.2).
 *
 * Single source of truth for product statuses/transitions, the product_events
 * vocabulary, HSN + GST-rate validation, units, and the launch category seed.
 * Everything here is pure data + pure functions (zero runtime deps except zod).
 *
 * Deviations from MART_DESIGN.md — recorded in docs/mart/SPINE_VERIFICATION.md:
 *  - `pending_approval` is ADDED to the product status set (draft|active|
 *    suspended in the doc) so "sent for approval" is a real state the admin
 *    listing-approval queue can query, not a flag on draft. Additive extension.
 *  - GST rate is stored as basis points (`gst_rate_bps`, 1800 = 18 %) to match
 *    the repo's money/rates convention (DEFAULT_GST_BPS, commission_bps).
 */
import { z } from 'zod'
import { productAttributesSchema } from './attributes'
import { martPromisesSchema } from './promises'

// ── Product status machine ───────────────────────────────────────────────────

export const PRODUCT_STATUSES = ['draft', 'pending_approval', 'active', 'suspended'] as const
export type ProductStatus = (typeof PRODUCT_STATUSES)[number]

/** What each product status may legally transition TO. Actor rules live in the API. */
export const PRODUCT_TRANSITIONS: Record<ProductStatus, readonly ProductStatus[]> = {
  draft: ['pending_approval'],
  // approve → active; reject → back to draft (with a reason in the event payload)
  pending_approval: ['active', 'draft'],
  active: ['suspended'],
  suspended: ['active'],
}

export function isValidProductTransition(from: ProductStatus, to: ProductStatus): boolean {
  return (PRODUCT_TRANSITIONS[from] as readonly string[]).includes(to)
}

/** product_events.event_type vocabulary — append-only, mirrors quote_events. */
export const PRODUCT_EVENT_TYPES = [
  'created',
  'edited',
  'submitted',
  'activated',
  'rejected',
  'suspended',
  'price_changed',
] as const
export type ProductEventType = (typeof PRODUCT_EVENT_TYPES)[number]

// ── GST / HSN ────────────────────────────────────────────────────────────────

/** Indian GST slabs for goods, in basis points. */
export const GST_RATE_BPS_OPTIONS = [0, 500, 1200, 1800, 2800] as const
export type GstRateBps = (typeof GST_RATE_BPS_OPTIONS)[number]

/** HSN codes are 4, 6 or 8 digits (chapter/heading/sub-heading/tariff item). */
export const HSN_CODE_RE = /^\d{4}(?:\d{2})?(?:\d{2})?$/

export const hsnCodeSchema = z.string().regex(HSN_CODE_RE, 'HSN code must be 4, 6 or 8 digits')
export const gstRateBpsSchema = z
  .number()
  .int()
  .refine((v): v is GstRateBps => (GST_RATE_BPS_OPTIONS as readonly number[]).includes(v), {
    message: 'GST rate must be one of 0, 5, 12, 18 or 28 percent',
  })

// ── Units ────────────────────────────────────────────────────────────────────

export const PRODUCT_UNITS = [
  'pcs',
  'kg',
  'g',
  'ltr',
  'ml',
  'm',
  'box',
  'pack',
  'set',
  'roll',
  'pair',
  'dozen',
  'bag',
  'sqm',
] as const
export type ProductUnit = (typeof PRODUCT_UNITS)[number]
export const productUnitSchema = z.enum(PRODUCT_UNITS)

// ── Launch category seed (rows live in mart_categories; this seeds them) ─────

/**
 * Cluster-dense launch (Kurnool): consumables/MRO only. BIS-notified
 * categories are blocked at launch by config, never certified (§2).
 * return_window_hours + commission_bps are founder decisions §9.2/§9.3 —
 * seeded with placeholders the founder overrides in the config table; the
 * code reads the TABLE, never these constants, at runtime.
 */
export interface MartCategorySeed {
  slug: string
  name_i18n: { en: string; hi: string; te: string }
  return_window_hours: number
  commission_bps: number
  bis_blocked: boolean
  sort_order: number
}

export const MART_CATEGORY_SEED: readonly MartCategorySeed[] = [
  { slug: 'fasteners', name_i18n: { en: 'Fasteners', hi: 'फास्टनर', te: 'ఫాస్టెనర్లు' }, return_window_hours: 48, commission_bps: 500, bis_blocked: false, sort_order: 1 },
  { slug: 'welding-consumables', name_i18n: { en: 'Welding consumables', hi: 'वेल्डिंग सामग्री', te: 'వెల్డింగ్ సామగ్రి' }, return_window_hours: 48, commission_bps: 500, bis_blocked: false, sort_order: 2 },
  { slug: 'abrasives', name_i18n: { en: 'Abrasives', hi: 'अपघर्षक', te: 'అబ్రేసివ్స్' }, return_window_hours: 48, commission_bps: 500, bis_blocked: false, sort_order: 3 },
  { slug: 'lubricants', name_i18n: { en: 'Oils & lubricants', hi: 'तेल और स्नेहक', te: 'నూనెలు & లూబ్రికెంట్లు' }, return_window_hours: 48, commission_bps: 500, bis_blocked: false, sort_order: 4 },
  { slug: 'cutting-tools', name_i18n: { en: 'Cutting tools', hi: 'कटिंग टूल्स', te: 'కటింగ్ టూల్స్' }, return_window_hours: 48, commission_bps: 500, bis_blocked: false, sort_order: 5 },
  { slug: 'hand-tools', name_i18n: { en: 'Hand tools', hi: 'हैंड टूल्स', te: 'హ్యాండ్ టూల్స్' }, return_window_hours: 48, commission_bps: 500, bis_blocked: false, sort_order: 6 },
  { slug: 'spares', name_i18n: { en: 'Machine spares', hi: 'मशीन स्पेयर', te: 'మెషిన్ స్పేర్లు' }, return_window_hours: 48, commission_bps: 500, bis_blocked: false, sort_order: 7 },
  // Helmets / some electricals are BIS-notified — the whole category stays
  // blocked at launch rather than certifying item by item (§2).
  { slug: 'safety-gear', name_i18n: { en: 'Safety gear', hi: 'सुरक्षा उपकरण', te: 'భద్రతా సామగ్రి' }, return_window_hours: 48, commission_bps: 500, bis_blocked: true, sort_order: 8 },
]

export const MART_CATEGORY_SLUGS = MART_CATEGORY_SEED.map((c) => c.slug) as [string, ...string[]]

// ── Zod schemas (API input; types derived) ───────────────────────────────────

export const priceTierInputSchema = z.object({
  min_qty: z.number().int().positive().max(1_000_000),
  unit_price_paise: z.number().int().positive(),
})
export type PriceTierInput = z.infer<typeof priceTierInputSchema>

/**
 * Tiers must have strictly increasing min_qty starting at 1, and strictly
 * decreasing unit price (bulk is cheaper — the substrate of pools).
 */
export const priceTiersSchema = z
  .array(priceTierInputSchema)
  .min(1)
  .max(8)
  .superRefine((tiers, ctx) => {
    if (tiers[0]?.min_qty !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'First tier must start at quantity 1' })
    }
    for (let i = 1; i < tiers.length; i++) {
      const prev = tiers[i - 1]!
      const cur = tiers[i]!
      if (cur.min_qty <= prev.min_qty) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Tier quantities must increase' })
      }
      if (cur.unit_price_paise >= prev.unit_price_paise) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Bulk tiers must be cheaper per unit' })
      }
    }
  })

export const PRODUCT_AVAILABILITY = ['in_stock', 'lead_time'] as const
export type ProductAvailability = (typeof PRODUCT_AVAILABILITY)[number]

/** Key/value specification rows shown as a table on the product page. */
export const productSpecSchema = z.object({
  k: z.string().trim().min(1).max(40),
  v: z.string().trim().min(1).max(120),
})
export type ProductSpec = z.infer<typeof productSpecSchema>

export const productInputSchema = z.object({
  category_slug: z.string().min(2).max(60),
  name: z.string().trim().min(3).max(140),
  description: z.string().trim().max(2000).optional(),
  brand: z.string().trim().max(60).optional(),
  specs: z.array(productSpecSchema).max(20).default([]),
  /** Seller-declared availability (no inventory is held — MART_DESIGN.md §3). */
  availability: z.enum(PRODUCT_AVAILABILITY).default('in_stock'),
  lead_time_days: z.number().int().min(1).max(90).optional(),
  hsn_code: hsnCodeSchema,
  gst_rate_bps: gstRateBpsSchema,
  unit: productUnitSchema,
  /** Storage object keys in the public-assets bucket (server validates prefix). */
  images: z.array(z.string().min(1).max(300)).max(6).default([]),
  min_order_qty: z.number().int().positive().max(1_000_000).default(1),
  country_of_origin: z.string().length(2).default('IN'),
  tiers: priceTiersSchema,
  /** E16 N40 — typed attributes; the route validates them against the category's definitions. */
  attributes: productAttributesSchema,
  /** E16 N41 — seller opt-in promises (badges are removed automatically after repeated breaches). */
  promises: martPromisesSchema,
  /** E16 N42 — a sample is an ordinary goods order of qty 1 at this price (paise, pre-GST); null = no samples. */
  sample_price_paise: z.number().int().positive().max(100_000_000).nullable().default(null),
})
export type ProductInput = z.infer<typeof productInputSchema>

/** Seller-side status actions (admin approve/reject is a separate route). */
export const productStatusActionSchema = z.enum(['submit', 'suspend', 'reactivate'])
export type ProductStatusAction = z.infer<typeof productStatusActionSchema>

/** Admin listing-approval actions. */
export const productReviewSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('reject'), reason: z.string().trim().min(5).max(500) }),
  z.object({ action: z.literal('suspend'), reason: z.string().trim().min(5).max(500) }),
])
export type ProductReviewInput = z.infer<typeof productReviewSchema>
