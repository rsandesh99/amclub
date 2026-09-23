import { z } from 'zod'
import { computeOrderAmounts, DEFAULT_GST_BPS, type OrderAmounts } from './money'
import type { PriceDisplay } from './price-display'

/**
 * ADR 019 (PRD Experience v3 E12a, N15) — package add-ons: priced extras the
 * provider sets before the buyer sees them ("+₹500 · 1 day faster"). The buyer
 * only picks; nothing here negotiates (§8.3).
 *
 * `packageCharge` is the ONE rule for what a package order costs with its
 * add-ons — checkout, the checkout preview and the buy box all call it:
 *   subtotal = package price + Σ add-on prices;
 *   the package's own % discount applies to the package price only;
 *   a coupon applies to the whole pre-GST subtotal;
 *   computeOrderAmounts runs once. With no add-ons it is the pre-ADR call.
 */
export const MAX_ACTIVE_ADDONS = 3
export const ADDON_LABEL_MAX = 40
export const ADDON_DAYS_DELTA_MIN = -30
export const ADDON_DAYS_DELTA_MAX = 30
export const ADDON_EXTRA_REVISIONS_MAX = 5

const label = z.string().trim().min(1).max(ADDON_LABEL_MAX)
export const addonLabelSchema = z
  .object({ en: label, hi: label.optional(), te: label.optional(), ta: label.optional() })
  .strict()

/** What a provider may send to create / edit an add-on. */
export const packageAddonInputSchema = z
  .object({
    label_i18n: addonLabelSchema,
    price_paise: z.number().int().positive().max(100_000_000),
    days_delta: z.number().int().min(ADDON_DAYS_DELTA_MIN).max(ADDON_DAYS_DELTA_MAX).default(0),
    extra_revisions: z.number().int().min(0).max(ADDON_EXTRA_REVISIONS_MAX).default(0),
    active: z.boolean().default(true),
  })
  .strict()
export type PackageAddonInput = z.infer<typeof packageAddonInputSchema>
export const packageAddonPatchSchema = z
  .object({
    label_i18n: addonLabelSchema.optional(),
    price_paise: z.number().int().positive().max(100_000_000).optional(),
    days_delta: z.number().int().min(ADDON_DAYS_DELTA_MIN).max(ADDON_DAYS_DELTA_MAX).optional(),
    extra_revisions: z.number().int().min(0).max(ADDON_EXTRA_REVISIONS_MAX).optional(),
    active: z.boolean().optional(),
  })
  .strict()

/** The checkout body's selection: distinct ids, at most three. */
export const addonIdsSchema = z
  .array(z.string().uuid())
  .max(MAX_ACTIVE_ADDONS)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'duplicate_addon' })

/** An add-on row as the server reads it (active, of this package). */
export interface PackageAddonRow {
  id: string
  label_i18n: { en: string; hi?: string | null; te?: string | null; ta?: string | null }
  price_paise: number
  days_delta: number
  extra_revisions: number
}

/** Frozen on checkout_sessions.addons and orders.addons. */
export const addonSnapshotSchema = z.array(
  z.object({
    id: z.string().uuid(),
    label: z.object({ en: z.string(), hi: z.string().optional(), te: z.string().optional(), ta: z.string().optional() }),
    pricePaise: z.number().int().positive(),
    daysDelta: z.number().int(),
    extraRevisions: z.number().int().min(0),
  }),
)
export type AddonSnapshot = z.infer<typeof addonSnapshotSchema>

export function addonSnapshot(rows: PackageAddonRow[]): AddonSnapshot {
  return rows.map((r) => ({
    id: r.id,
    label: {
      en: r.label_i18n.en,
      ...(r.label_i18n.hi ? { hi: r.label_i18n.hi } : {}),
      ...(r.label_i18n.te ? { te: r.label_i18n.te } : {}),
      ...(r.label_i18n.ta ? { ta: r.label_i18n.ta } : {}),
    },
    pricePaise: Number(r.price_paise),
    daysDelta: Number(r.days_delta),
    extraRevisions: Number(r.extra_revisions),
  }))
}

/**
 * Resolve a selection against the package's ACTIVE add-ons. Any id that is not
 * one of them (removed, deactivated, another package's, or the switch is off
 * and `active` is empty) → `addon_changed`. Keeps the package's sort order.
 */
export function resolveAddonSelection(active: PackageAddonRow[], ids: string[]): { ok: true; rows: PackageAddonRow[] } | { ok: false; code: 'addon_changed' } {
  const want = new Set(ids)
  const rows = active.filter((a) => want.has(a.id))
  if (rows.length !== want.size) return { ok: false, code: 'addon_changed' }
  return { ok: true, rows }
}

/** The package discount in paise, exactly as computeOrderAmounts rounds it. */
export function packageDiscountPaise(pricePaise: number, discountBps: number): number {
  return Math.round((Math.round(pricePaise) * discountBps) / 10000)
}

export interface PackageCharge {
  amounts: OrderAmounts
  deliveryDays: number
  revisionMax: number | null
  addons: AddonSnapshot
  /** Σ add-on prices (display only; never re-added by a client). */
  addonsPaise: number
}

export function packageCharge(input: {
  pricePaise: number
  discountBps: number
  commissionBps: number
  deliveryDays: number
  revisionCount: number | null
  addons: PackageAddonRow[]
  couponDiscountPaise?: number
  gstBps?: number
}): PackageCharge {
  const coupon = Math.max(0, Math.round(input.couponDiscountPaise ?? 0))
  const snap = addonSnapshot(input.addons)
  if (snap.length === 0) {
    // Byte-identical to the checkout package branch before ADR 019.
    return {
      amounts: computeOrderAmounts({
        pricePaise: input.pricePaise,
        discountBps: input.discountBps,
        commissionBps: input.commissionBps,
        ...(input.gstBps !== undefined ? { gstBps: input.gstBps } : {}),
        extraDiscountPaise: coupon,
      }),
      deliveryDays: input.deliveryDays,
      revisionMax: input.revisionCount,
      addons: [],
      addonsPaise: 0,
    }
  }
  const addonsPaise = snap.reduce((s, a) => s + a.pricePaise, 0)
  const days = snap.reduce((s, a) => s + a.daysDelta, 0)
  const revisions = snap.reduce((s, a) => s + a.extraRevisions, 0)
  return {
    amounts: computeOrderAmounts({
      pricePaise: Math.round(input.pricePaise) + addonsPaise,
      discountBps: 0,
      commissionBps: input.commissionBps,
      ...(input.gstBps !== undefined ? { gstBps: input.gstBps } : {}),
      extraDiscountPaise: packageDiscountPaise(input.pricePaise, input.discountBps) + coupon,
    }),
    deliveryDays: Math.max(1, input.deliveryDays + days),
    revisionMax: revisions > 0 ? (input.revisionCount ?? 0) + revisions : input.revisionCount,
    addons: snap,
    addonsPaise,
  }
}

/** The pre-GST value a coupon is evaluated against (subtotal − package discount). */
export function couponBasePaise(input: { pricePaise: number; discountBps: number; addons: PackageAddonRow[] }): number {
  const addonsPaise = input.addons.reduce((s, a) => s + Number(a.price_paise), 0)
  return Math.round(input.pricePaise) - packageDiscountPaise(input.pricePaise, input.discountBps) + addonsPaise
}

/** The N16 display for a package charge (the buy box / checkout render it; never sum). */
export function packageChargeDisplay(c: PackageCharge, input: { discountBps: number; buyerHasGstin?: boolean; gstBps?: number }): PriceDisplay {
  const a = c.amounts
  return {
    listPaise: a.pricePaise,
    discountPaise: a.discountPaise,
    taxablePaise: a.taxablePaise,
    gstPaise: a.gstPaise,
    gstBps: input.gstBps ?? DEFAULT_GST_BPS,
    totalPaise: a.totalPaise,
    itcPaise: input.buyerHasGstin ? a.gstPaise : null,
    discountPct: Math.round(input.discountBps / 100),
    memberPaise: null,
    memberExtraPct: 0,
  }
}

/** Invoice lines for a package order with add-ons: the package, then one line per add-on. Their sum is the order price. */
export function addonInvoiceLines(order: { title: string; pricePaise: number }, addons: AddonSnapshot): { label: string; paise: number }[] {
  const addonsPaise = addons.reduce((s, a) => s + a.pricePaise, 0)
  return [{ label: order.title, paise: order.pricePaise - addonsPaise }, ...addons.map((a) => ({ label: `Add-on: ${a.label.en}`, paise: a.pricePaise }))]
}

/** A stable signature of a selection (sorted ids) — the web client keys its idempotency on it. */
export const addonSelectionKey = (ids: string[]): string => [...ids].sort().join(',')
