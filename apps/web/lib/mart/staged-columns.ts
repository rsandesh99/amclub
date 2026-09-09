import 'server-only'
import { MART_ENABLED } from '@/lib/flags'

/**
 * Columns that exist ONLY after the staged Mart migrations (0022–0025) are
 * applied — which happens in the Launch Gate deploy together with
 * MART_ENABLED=true (MART_DESIGN.md §8.2). Until then production does NOT
 * have them, and a PostgREST select that names a missing column fails the
 * whole query (42703), returning null data — which is how a dark build turned
 * off RFQ fan-out, the buyer RFQ list, the compare view and quote→order on
 * 2026-09-09 (verify-rfq 2/12).
 *
 * Rule (CLAUDE.md "Inertness is a deliverable"): shared services code never
 * names a staged column directly. It appends one of these fragments, which
 * are EMPTY while the flag is off. `scripts/verify-mart-static-inert.ts`
 * enforces this by grepping every non-Mart select string.
 *
 * `SELECT *` is unaffected (it returns whatever columns exist) and stays as is.
 */

/** rfqs: kind + Mart category + spec (0024). */
export const RFQ_GOODS_COLS = MART_ENABLED ? ', kind, mart_category_slug, goods_spec' : ''

/** rfqs list shape: kind + Mart category (0024). */
export const RFQ_GOODS_LIST_COLS = MART_ENABLED ? ', kind, mart_category_slug' : ''

/** quotes: goods terms (0024). */
export const QUOTE_GOODS_COLS = MART_ENABLED ? ', unit_price_paise, qty, gst_rate_bps, hsn_code, product_id' : ''

/** True only when the row can carry goods and says so. Safe on pre-0024 rows. */
export function isGoodsRow(row: { kind?: string | null } | null | undefined): boolean {
  return MART_ENABLED && row?.kind === 'goods'
}
