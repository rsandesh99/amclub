import { z } from 'zod'
import { priceDisplaySchema, type PriceDisplay } from './price-display'
import { PACKAGE_TIERS } from './packages-v3'

/**
 * PRD Experience v3 E9 — homes and retention (flag `home`).
 *
 * FR-9.3 (N26) "Buy again" / "Repeat requirement": a finished package order
 * opens an ordinary Buy-now checkout for the same package at TODAY's server
 * price (both prices shown when they differ); a paused or deleted package
 * becomes "Find similar"; a finished quote order repeats its requirement
 * through the existing repost (`/app/rfq/new?from=`). No new money path.
 */

const common = {
  orderId: z.string().uuid(),
  /** The order's own title (the buyer's content). */
  title: z.string(),
  providerName: z.string().nullable(),
}

export const buyAgainSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('package'),
    ...common,
    packageId: z.string().uuid(),
    tier: z.enum(PACKAGE_TIERS).nullable(),
    /** What the order charged (stored amounts, coupon included). */
    displayThen: priceDisplaySchema,
    /** Today's server price for the same package (what checkout will charge). */
    displayNow: priceDisplaySchema,
    priceChanged: z.boolean(),
    href: z.string(),
  }),
  z.object({ kind: z.literal('similar'), ...common, searchHref: z.string() }),
  z.object({ kind: z.literal('repeat'), ...common, rfqId: z.string().uuid(), href: z.string() }),
])
export type BuyAgain = z.infer<typeof buyAgainSchema>

export const buyAgainShelfSchema = z.object({ items: z.array(buyAgainSchema) })
export type BuyAgainShelf = z.infer<typeof buyAgainShelfSchema>

/** FR-9.3 — the home's "Buy again" shelf holds up to this many packages. */
export const BUY_AGAIN_SHELF_MAX = 4

/** The price changed when what GST is charged on differs (list price, package discount or a coupon then). */
export function isPriceChanged(then: Pick<PriceDisplay, 'taxablePaise'>, now: Pick<PriceDisplay, 'taxablePaise'>): boolean {
  return then.taxablePaise !== now.taxablePaise
}

/** "Repeat requirement" — the existing repost, tagged with its entry point. */
export function repeatRequirementHref(rfqId: string): string {
  return `/app/rfq/new?from=${encodeURIComponent(rfqId)}&entry=buy_again`
}

/**
 * The shelf's rows: finished package orders, the most recently completed
 * first, one row per package, at most `max`.
 */
export function pickBuyAgainOrders<T extends { packageId: string | null; completedAt: string | null; createdAt: string }>(orders: readonly T[], max = BUY_AGAIN_SHELF_MAX): T[] {
  const at = (o: T) => Date.parse(o.completedAt ?? o.createdAt)
  const seen = new Set<string>()
  const out: T[] = []
  for (const o of [...orders].sort((a, b) => at(b) - at(a))) {
    if (!o.packageId || seen.has(o.packageId)) continue
    seen.add(o.packageId)
    out.push(o)
    if (out.length >= max) break
  }
  return out
}

// ── FR-9.4 the profile-completeness card ────────────────────────────────────────
/** The card shows below this completeness (%). */
export const HOME_COMPLETENESS_THRESHOLD = 80
/** Dismissing it hides it for this many days. */
export const HOME_DISMISS_DAYS = 7

/** The ms timestamp a dismissal made at `nowMs` lasts until. */
export function dismissUntil(nowMs: number): number {
  return nowMs + HOME_DISMISS_DAYS * 86_400_000
}

/** True while a stored dismissal (ms timestamp, or anything unparseable) still hides the card. */
export function isDismissed(stored: string | null | undefined, nowMs: number): boolean {
  const until = Number(stored)
  return Number.isFinite(until) && until > nowMs
}
