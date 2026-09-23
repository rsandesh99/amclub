import { z } from 'zod'

/**
 * AMC Mart config registry (MART_DESIGN.md §9 — founder decisions are CONFIG,
 * never constants). Every key the runtime reads from `mart_settings` is
 * declared here with its Zod shape, so the admin editor validates exactly what
 * the code consumes and an unknown key can never be written.
 *
 * Readers: lib/mart/config.ts (getMartSetting*), lib/mart/pools.ts,
 * lib/mart/goods-transitions.ts, lib/mart/documents-agent.ts,
 * lib/orders/transitions.ts (TDS), /api/v1/mart/checkout + cart/preview.
 */
import { POOL_PAYMENT_MODES } from './pools'
import { promiseBreachLimitSchema } from './promises'

export const POOL_ORDER_MODELS = ['per_member'] as const

/** §9.2 — who bears return freight for a category (config, buyer-facing note). */
export const RETURN_FREIGHT_PAYERS = ['seller', 'buyer', 'split'] as const
export type ReturnFreightPayer = (typeof RETURN_FREIGHT_PAYERS)[number]

export const MART_SETTING_DEFS = {
  eway_bill_threshold_paise: {
    schema: z.number().int().min(0).max(100_000_000_000),
    decision: '§2 e-way bill',
    hint: 'Consignment value (paise) at or above which dispatch must capture e-way bill fields. Statutory default ₹50,000.',
  },
  auto_approve_after_listings: {
    schema: z.number().int().min(0).max(1000),
    decision: 'Catalog Agent doctrine',
    hint: 'Admin approves this many listings per seller; later submissions auto-activate (still audited).',
  },
  tds: {
    schema: z.object({ section: z.string().min(2).max(12), rate_bps: z.number().int().min(0).max(2000), threshold_paise: z.number().int().min(0) }),
    decision: '§2 TDS under MoR — CA sets',
    hint: 'rate_bps = 0 until the CA confirms section + rate; payouts record whatever is here.',
  },
  goods_delivery_days: {
    schema: z.number().int().min(1).max(60),
    decision: '§3.2 fulfilment',
    hint: 'Due date a goods order carries (seller-arranged local delivery or pickup).',
  },
  pool_payment_mode: {
    schema: z.enum(POOL_PAYMENT_MODES),
    decision: 'ADR-006 / PSP report §5',
    hint: 'pay_on_close at launch. block_capture is refused at join until the PSP block-and-capture report is signed off.',
  },
  pool_pay_window_hours: {
    schema: z.number().int().min(1).max(720),
    decision: 'ADR-006',
    hint: 'Hours a member has to pay their goods order after a pool closes met.',
  },
  pool_order_model: {
    schema: z.enum(POOL_ORDER_MODELS),
    decision: '§9.1',
    hint: 'One goods order per member — the only model that reuses every money path (ADR-006).',
  },
  pool_categories: {
    schema: z.array(z.string().min(1).max(60)).max(20),
    decision: '§9.4',
    hint: 'Launch pool categories (slugs of active Mart categories). The Group-Buy Agent drafts one pool per category on schedule.',
  },
  pool_schedule_day_of_month: {
    schema: z.number().int().min(1).max(28),
    decision: 'Group-Buy Agent schedule',
    hint: 'Day of month the agent drafts scheduled pools.',
  },
  promise_breach_limit: {
    schema: promiseBreachLimitSchema,
    decision: 'E16 N41 seller promises',
    hint: 'A promise badge (Ships in 48 h, GST invoice within 24 h) disappears from a product once it has `count` measured breaches within `window_days`. Default 3 in 90 days.',
  },
  pool_open_limits: {
    schema: z.object({ min_open_hours: z.number().int().min(1).max(720), max_open_days: z.number().int().min(1).max(90) }),
    decision: 'Pool approval limits',
    hint: 'Bounds on closes_at the founder can set when approving a draft.',
  },
} as const

export type MartSettingKey = keyof typeof MART_SETTING_DEFS
export const MART_SETTING_KEYS = Object.keys(MART_SETTING_DEFS) as MartSettingKey[]

/** Validate a value for a known key. Unknown keys never parse (closed registry). */
export function parseMartSetting(key: string, value: unknown): { ok: true; key: MartSettingKey; value: unknown } | { ok: false; error: string } {
  const def = (MART_SETTING_DEFS as Record<string, { schema: z.ZodTypeAny }>)[key]
  if (!def) return { ok: false, error: `unknown_key:${key}` }
  const r = def.schema.safeParse(value)
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || key}: ${i.message}`).join('; ') }
  return { ok: true, key: key as MartSettingKey, value: r.data }
}

/** PUT /api/v1/mart/admin/settings body — value is checked per key by parseMartSetting. */
export const martSettingPutSchema = z.object({
  key: z.enum(MART_SETTING_KEYS as [MartSettingKey, ...MartSettingKey[]]),
  value: z.unknown(),
})
export type MartSettingPutInput = z.infer<typeof martSettingPutSchema>

const nameI18nSchema = z.object({ en: z.string().trim().min(1).max(80), hi: z.string().trim().min(1).max(80).optional(), te: z.string().trim().min(1).max(80).optional() })

/** PATCH /api/v1/mart/admin/categories/[slug] — §9.2 (return window, freight) and §9.3 (commission) live here. */
export const martCategoryPatchSchema = z
  .object({
    name_i18n: nameI18nSchema.optional(),
    return_window_hours: z.number().int().min(0).max(720).optional(),
    commission_bps: z.number().int().min(0).max(5000).optional(),
    return_freight_payer: z.enum(RETURN_FREIGHT_PAYERS).optional(),
    /** E16 N43 (0069, staged) — "Not returnable" (damaged / wrong / short stay claimable). */
    returnable: z.boolean().optional(),
    /** E16 N43 — the CA-reviewed §17(5) flag: false = "ITC may not be available on this item". */
    itc_eligible: z.boolean().optional(),
    bis_blocked: z.boolean().optional(),
    is_active: z.boolean().optional(),
    sort_order: z.number().int().min(0).max(1000).nullable().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'Nothing to update' })
export type MartCategoryPatchInput = z.infer<typeof martCategoryPatchSchema>
