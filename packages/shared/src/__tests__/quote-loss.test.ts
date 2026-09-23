import { describe, expect, it } from 'vitest'
import { compareQuotes, lossInsight, lossPairFromLabel, quoteLossLabel, quoteLostPayloadSchema, quoteNormalizedTotal, type CompareQuoteInput } from '../index'

const W = '22222222-2222-4222-8222-222222222222'
const svc = (pricePaise: number, gstIncluded: boolean | null, deliveryDays: number | null) => ({ pricePaise, gstIncluded, deliveryDays })

describe('E7 FR-7.3 (N22) — loss labels', () => {
  it('the normalised total is exactly the compare screen number (services, every GST state; goods)', () => {
    const rows: CompareQuoteInput[] = [
      { id: 'a', kind: 'service', pricePaise: 4_500_00, deliveryDays: 4, gstIncluded: false, transportIncluded: null, validUntil: null, advancePercent: null },
      { id: 'b', kind: 'service', pricePaise: 3_900_07, deliveryDays: 6, gstIncluded: null, transportIncluded: null, validUntil: null, advancePercent: null },
      { id: 'c', kind: 'service', pricePaise: 5_200_00, deliveryDays: 3, gstIncluded: true, transportIncluded: null, validUntil: null, advancePercent: null },
      { id: 'g', kind: 'goods', pricePaise: 0, deliveryDays: 5, gstIncluded: null, transportIncluded: null, validUntil: null, advancePercent: null, goods: { unitPricePaise: 12_345, qty: 7, gstRateBps: 1200 } },
    ]
    const cmp = new Map(compareQuotes(rows, { today: '2026-09-23' }).map((r) => [r.id, r.normalizedTotalPaise]))
    for (const r of rows) expect(quoteNormalizedTotal({ pricePaise: r.pricePaise, gstIncluded: r.gstIncluded, deliveryDays: r.deliveryDays, goods: r.goods ?? null })).toBe(cmp.get(r.id))
  })

  it('the PRD example: B wins; A and C are labelled against B (positive = dearer / slower)', () => {
    const b = { id: W, ...svc(3_900_00, null, 6) } // ₹4,602 all-in
    const a = quoteLossLabel(svc(4_500_00, false, 4), b) // ₹5,310
    const c = quoteLossLabel(svc(5_200_00, true, 3), b) // ₹5,200
    expect(a).toEqual({ v: 1, accepted_quote_id: W, price_delta_paise: 5_310_00 - 4_602_00, days_delta: -2 })
    expect(c).toEqual({ v: 1, accepted_quote_id: W, price_delta_paise: 5_200_00 - 4_602_00, days_delta: -3 })
    expect(quoteLostPayloadSchema.parse(a)).toEqual(a)
  })

  it('an unstated delivery on either side gives no days delta', () => {
    expect(quoteLossLabel(svc(1_000_00, false, null), { id: W, ...svc(1_000_00, false, 3) }).days_delta).toBeNull()
    expect(quoteLossLabel(svc(1_000_00, false, 3), { id: W, ...svc(1_000_00, false, 0) }).days_delta).toBeNull()
  })

  it('the schema is strict: no name, no provider id, no winner price may ride along', () => {
    expect(quoteLostPayloadSchema.safeParse({ v: 1, accepted_quote_id: W, price_delta_paise: 1, days_delta: null, winner_price_paise: 5 }).success).toBe(false)
  })

  it('a stored label rebuilds the same insights pair the direct comparison gives', () => {
    const winner = { id: W, ...svc(4_000_00, false, 5) }
    const mine = svc(4_800_00, null, 7)
    const label = quoteLossLabel(mine, winner)
    const pair = lossPairFromLabel({ totalPaise: quoteNormalizedTotal(mine), deliveryDays: mine.deliveryDays }, label)
    expect(pair).toEqual({ mine: { totalPaise: 5_664_00, deliveryDays: 7 }, winner: { totalPaise: 4_720_00, deliveryDays: 5 } })
    expect(lossInsight([pair]).price).toEqual({ n: 1, of: 1, medianPct: null })
  })
})
