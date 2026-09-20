import { compareLabel, type CompareQuoteResult, type PointerLocale } from '@amclub/shared'
import type { ChatParts } from '../llm/gateway'

/**
 * Prompt parts for `quote_compare@v1` (S1.2 §2). TRUSTED ONLY: the numbers and
 * flags code already computed, with neutral labels `Quote A…G` in input order
 * instead of provider names. Free text (scope, message) and provider names are
 * never accepted by this builder — the input type has no field for them and
 * the taint test spreads poisoned objects through to prove they are ignored.
 */
export interface ComparePointerQuote {
  id: string
  kind: 'service' | 'goods'
  pricePaise: number
  deliveryDays: number | null
  gstIncluded: boolean | null
  transportIncluded: boolean | null
  validUntil: string | null
  advancePercent: number | null
  goods?: { unitPricePaise: number; qty: number; gstRateBps: number } | null
  medianResponseMinutes?: number | null
  completedOrders?: number | null
}

export interface ComparePointerPartsInput {
  locale: PointerLocale
  today: string
  quotes: readonly ComparePointerQuote[]
  results: readonly CompareQuoteResult[]
}

/** ₹ with Indian digit grouping from integer paise (no floats). */
export function formatInrFromPaise(paise: number): string {
  const rupees = Math.trunc(Math.abs(paise) / 100)
  const p = Math.abs(paise) % 100
  const s = String(rupees)
  const last3 = s.slice(-3)
  const rest = s.slice(0, -3)
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3
  const sign = paise < 0 ? '-' : ''
  return p ? `${sign}₹${grouped}.${String(p).padStart(2, '0')}` : `${sign}₹${grouped}`
}

const term = (v: boolean | null, yes: string, no: string) => (v === null ? 'unstated' : v ? yes : no)

export function buildComparePointerParts(input: ComparePointerPartsInput): ChatParts {
  const byId = new Map(input.results.map((r) => [r.id, r]))
  const trusted: string[] = [`locale: ${input.locale}`, `today: ${input.today}`, `quotes: ${input.quotes.length}`]
  input.quotes.forEach((q, i) => {
    const r = byId.get(q.id)
    const label = compareLabel(i)
    const notes = (r?.normalizationNotes ?? []).map((n) => (n.paise != null ? `${n.code} ${formatInrFromPaise(n.paise)}` : n.code)).join(', ') || 'none'
    const priceLine = q.kind === 'goods' && q.goods
      ? `unit price ${formatInrFromPaise(q.goods.unitPricePaise)} × ${q.goods.qty}, GST ${q.goods.gstRateBps / 100}%`
      : `price as quoted ${formatInrFromPaise(q.pricePaise)}`
    trusted.push(
      [
        `Quote ${label} (quote_id ${q.id}):`,
        priceLine,
        `normalised total ${formatInrFromPaise(r?.normalizedTotalPaise ?? q.pricePaise)} (notes: ${notes})`,
        `delivery ${q.deliveryDays != null && q.deliveryDays > 0 ? `${q.deliveryDays} days` : 'unstated'}`,
        `GST: ${q.kind === 'goods' ? 'stated per line' : term(q.gstIncluded, 'included', 'not included')}`,
        `transport: ${term(q.transportIncluded, 'included', 'not included')}`,
        `valid until: ${q.validUntil ?? 'unstated'}`,
        `advance: ${q.advancePercent == null ? 'unstated' : `${q.advancePercent}%`}`,
        `median response: ${q.medianResponseMinutes != null ? `${q.medianResponseMinutes} min` : 'no data'}`,
        `completed orders: ${q.completedOrders ?? 0}`,
        `flags: ${(r?.flags ?? []).join(', ') || 'none'}`,
      ].join('; '),
    )
  })
  return { trusted }
}
