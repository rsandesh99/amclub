import { z } from 'zod'
import { DEFAULT_GST_BPS } from './money'

/**
 * Comparability engine (BUILD_PROMPTS S1.2). Deterministic code, never a
 * model: given the quotes a buyer sees, compute a normalised total per quote
 * and the flags that make the differences explicit. The total is what checkout
 * CHARGES (ADR-017): GST is added when a quote says it is excluded AND when it
 * is silent (flagged `gst_unstated`, as checkout adds it); an included price is
 * taken as-is (ADR-015). Transport is a
 * flag only (there is no rate to add). Pure, zero deps beyond zod; the web
 * page, the compare route, mobile and the golden set all call this one
 * function. All money in integer paise.
 */

export const COMPARE_FLAGS = [
  'gst_not_included',
  'gst_unstated',
  'transport_not_included',
  'transport_unstated',
  'delivery_unstated',
  'validity_short',
  'validity_expired',
  'advance_high',
  'advance_unstated',
  'cheapest_after_normalization',
  'fastest',
  'only_quote',
] as const
export type CompareFlag = (typeof COMPARE_FLAGS)[number]
export const compareFlagSchema = z.enum(COMPARE_FLAGS)

/** Flags that are FACTS from code (never advice) — rendered in the success colour. */
export const COMPARE_FACT_FLAGS: readonly CompareFlag[] = ['cheapest_after_normalization', 'fastest']
/** Flags that need the buyer's attention (attention colour). */
export const COMPARE_ATTENTION_FLAGS: readonly CompareFlag[] = ['gst_not_included', 'transport_not_included', 'validity_short', 'validity_expired', 'advance_high']
/** Flags that mark silence (neutral colour). */
export const COMPARE_NEUTRAL_FLAGS: readonly CompareFlag[] = ['gst_unstated', 'transport_unstated', 'delivery_unstated', 'advance_unstated', 'only_quote']

export const VALIDITY_SHORT_DAYS = 3
export const ADVANCE_HIGH_PERCENT = 50

export interface CompareQuoteInput {
  id: string
  kind: 'service' | 'goods'
  pricePaise: number
  deliveryDays: number | null
  gstIncluded: boolean | null
  transportIncluded: boolean | null
  /** ISO date YYYY-MM-DD or null. */
  validUntil: string | null
  advancePercent: number | null
  goods?: { unitPricePaise: number; qty: number; gstRateBps: number } | null
}

export type NormalizationNoteCode = 'gst_added' | 'tie_broken'
export interface NormalizationNote {
  code: NormalizationNoteCode
  paise?: number
}

export interface CompareQuoteResult {
  id: string
  normalizedTotalPaise: number
  normalizationNotes: NormalizationNote[]
  flags: CompareFlag[]
}

export interface CompareOptions {
  /** IST calendar date, YYYY-MM-DD. */
  today: string
  /** Services GST rate applied when a quote says GST is NOT included. */
  servicesGstBps?: number
}

/** The M2 goods money math (was two lines in mapQuoteGoods; lifted here so compare + display share it). */
export function goodsQuoteMoney(input: { unitPricePaise: number; qty: number; gstRateBps: number }): { taxablePaise: number; gstPaise: number; totalInclGstPaise: number } {
  const taxablePaise = input.unitPricePaise * input.qty
  const gstPaise = Math.round((taxablePaise * input.gstRateBps) / 10000)
  return { taxablePaise, gstPaise, totalInclGstPaise: taxablePaise + gstPaise }
}

/** GST at `bps` on a services price (rounded to the paise). */
export function servicesGstPaise(pricePaise: number, bps: number): number {
  return Math.round((pricePaise * bps) / 10000)
}

/** Whole days from `today` to `iso` (negative when past). Both YYYY-MM-DD, UTC-midnight arithmetic. */
export function daysUntil(iso: string, today: string): number {
  const a = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
  const b = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)))
  return Math.round((a - b) / 86_400_000)
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function compareQuotes(quotes: readonly CompareQuoteInput[], opts: CompareOptions): CompareQuoteResult[] {
  const gstBps = opts.servicesGstBps ?? DEFAULT_GST_BPS
  const results: CompareQuoteResult[] = quotes.map((q) => {
    const notes: NormalizationNote[] = []
    const flags: CompareFlag[] = []
    let total: number

    if (q.kind === 'goods' && q.goods) {
      // Goods: qty × unit + GST at the quote's own slab (the M2 math). GST is
      // always explicit on a goods quote, so no gst_* flags apply.
      const m = goodsQuoteMoney(q.goods)
      total = m.totalInclGstPaise
      if (m.gstPaise > 0) notes.push({ code: 'gst_added', paise: m.gstPaise })
    } else {
      total = q.pricePaise
      // ADR-017 — excluded and unstated both add GST on top, exactly as checkout's quote branch charges them.
      if (q.gstIncluded !== true) {
        const gst = servicesGstPaise(q.pricePaise, gstBps)
        total += gst
        notes.push({ code: 'gst_added', paise: gst })
        flags.push(q.gstIncluded === false ? 'gst_not_included' : 'gst_unstated')
      }
    }

    if (q.transportIncluded === false) flags.push('transport_not_included')
    else if (q.transportIncluded === null) flags.push('transport_unstated')

    if (q.deliveryDays == null || !(q.deliveryDays > 0)) flags.push('delivery_unstated')

    if (q.validUntil && ISO_DATE.test(q.validUntil)) {
      const d = daysUntil(q.validUntil, opts.today)
      if (d < 0) flags.push('validity_expired')
      else if (d <= VALIDITY_SHORT_DAYS) flags.push('validity_short')
    }

    if (q.advancePercent == null) flags.push('advance_unstated')
    else if (q.advancePercent > ADVANCE_HIGH_PERCENT) flags.push('advance_high')

    return { id: q.id, normalizedTotalPaise: total, normalizationNotes: notes, flags }
  })

  if (results.length === 1) {
    results[0]!.flags.push('only_quote')
    return results
  }
  if (results.length === 0) return results

  // Exactly one cheapest and one fastest; ties → the earlier id in input order (noted).
  let cheapest = 0
  let cheapestTie = false
  for (let i = 1; i < results.length; i++) {
    const a = results[i]!.normalizedTotalPaise
    const b = results[cheapest]!.normalizedTotalPaise
    if (a < b) {
      cheapest = i
      cheapestTie = false
    } else if (a === b) cheapestTie = true
  }
  results[cheapest]!.flags.push('cheapest_after_normalization')
  if (cheapestTie) results[cheapest]!.normalizationNotes.push({ code: 'tie_broken' })

  let fastest = -1
  let fastestTie = false
  quotes.forEach((q, i) => {
    if (q.deliveryDays == null || !(q.deliveryDays > 0)) return
    if (fastest === -1) {
      fastest = i
      return
    }
    const cur = quotes[fastest]!.deliveryDays as number
    if (q.deliveryDays < cur) {
      fastest = i
      fastestTie = false
    } else if (q.deliveryDays === cur) fastestTie = true
  })
  if (fastest >= 0) {
    results[fastest]!.flags.push('fastest')
    if (fastestTie && !results[fastest]!.normalizationNotes.some((n) => n.code === 'tie_broken')) results[fastest]!.normalizationNotes.push({ code: 'tie_broken' })
  }
  return results
}

/** Stable neutral labels the pointer prompt uses instead of provider names (input order). */
export const COMPARE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const
export function compareLabel(index: number): string {
  return COMPARE_LABELS[index] ?? String.fromCharCode(65 + index)
}
