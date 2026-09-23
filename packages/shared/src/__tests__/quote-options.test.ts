import { describe, expect, it } from 'vitest'
import { choiceExtremes, quoteChoices, quoteOptionCharge, quoteOptionsProblems, quoteOptionsSchema, quoteChargeAmounts, quoteSchema, type CompareQuoteInput } from '../index'

const base = (id: string, pricePaise: number, deliveryDays: number, gstIncluded: boolean | null = false): CompareQuoteInput => ({
  id, kind: 'service', pricePaise, deliveryDays, gstIncluded, transportIncluded: true, validUntil: null, advancePercent: 0,
})

describe('quote options (ADR 020)', () => {
  it('coherence: express faster + never cheaper; economy slower + never dearer', () => {
    const std = { pricePaise: 100_000, deliveryDays: 10 }
    expect(quoteOptionsProblems(std, [{ label: 'express', price_paise: 130_000, delivery_days: 5 }, { label: 'economy', price_paise: 90_000, delivery_days: 15 }])).toEqual([])
    expect(quoteOptionsProblems(std, [{ label: 'express', price_paise: 100_000, delivery_days: 10 }])).toEqual(['express_not_faster'])
    expect(quoteOptionsProblems(std, [{ label: 'express', price_paise: 90_000, delivery_days: 5 }])).toEqual(['express_cheaper'])
    expect(quoteOptionsProblems(std, [{ label: 'economy', price_paise: 110_000, delivery_days: 10 }])).toEqual(['economy_not_slower', 'economy_dearer'])
  })

  it('at most one of each label, two in all, strict rows', () => {
    expect(quoteOptionsSchema.safeParse([{ label: 'express', price_paise: 1, delivery_days: 1 }, { label: 'express', price_paise: 2, delivery_days: 1 }]).success).toBe(false)
    expect(quoteOptionsSchema.safeParse([{ label: 'standard', price_paise: 1, delivery_days: 1 }]).success).toBe(false)
    expect(quoteOptionsSchema.safeParse([{ label: 'express', price_paise: 1, delivery_days: 1, extra: 1 }]).success).toBe(false)
    expect(quoteSchema.safeParse({ rfq_id: '11111111-1111-4111-8111-111111111111', price_paise: 100, delivery_days: 3, scope: 'x'.repeat(20), options: [{ label: 'economy', price_paise: 90, delivery_days: 5 }] }).success).toBe(true)
  })

  it('choices: Standard is the quote row; each option is charged as checkout would (ADR-015 per option)', () => {
    const quotes = [
      { ...base('a', 100_000, 10), options: [{ id: 'ax', label: 'express' as const, pricePaise: 130_000, deliveryDays: 4 }, { id: 'ae', label: 'economy' as const, pricePaise: 90_000, deliveryDays: 15 }] },
      { ...base('b', 95_000, 8, true) },
    ]
    const cs = quoteChoices(quotes, { today: '2026-09-23' })
    const a = cs.get('a')!
    expect(a.map((c) => c.label)).toEqual(['economy', 'standard', 'express'])
    expect(a.find((c) => c.label === 'express')!.normalizedTotalPaise).toBe(quoteChargeAmounts({ pricePaise: 130_000, gstIncluded: false, commissionBps: 0 }).totalPaise)
    expect(a.find((c) => c.label === 'standard')!.optionId).toBeNull()
    // b says GST included: its total is its price.
    expect(cs.get('b')![0]!.normalizedTotalPaise).toBe(95_000)
    // a's Express is the fastest choice; a's column shows "fastest" when Express is picked.
    expect(a.find((c) => c.label === 'express')!.flags).toContain('fastest')
    expect(choiceExtremes(cs)).toEqual({ lowest: { quoteId: 'b', optionId: null }, fastest: { quoteId: 'a', optionId: 'ax' } })
  })

  it('an accepted option charges its price under the quote GST mode', () => {
    expect(quoteOptionCharge({ pricePaise: 118_000, gstIncluded: true, commissionBps: 1000 }).totalPaise).toBe(118_000)
    expect(quoteOptionCharge({ pricePaise: 100_000, gstIncluded: null, commissionBps: 1000 }).totalPaise).toBe(118_000)
  })
})
