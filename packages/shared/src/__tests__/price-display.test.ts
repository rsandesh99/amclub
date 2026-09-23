import { describe, expect, it } from 'vitest'
import { priceDisplay } from '../price-display'
import { computeOrderAmounts } from '../money'

describe('priceDisplay (N16)', () => {
  it('is exactly what checkout charges', () => {
    const d = priceDisplay({ pricePaise: 299900, discountBps: 0 })
    const a = computeOrderAmounts({ pricePaise: 299900, discountBps: 0, commissionBps: 1000 })
    expect(d).toMatchObject({ taxablePaise: a.taxablePaise, gstPaise: a.gstPaise, totalPaise: a.totalPaise })
    expect(d.totalPaise).toBe(353882) // ₹2,999 + 18 % = ₹3,538.82
  })
  it('applies the package discount before GST', () => {
    const d = priceDisplay({ pricePaise: 100000, discountBps: 1000 })
    expect(d).toMatchObject({ listPaise: 100000, discountPaise: 10000, taxablePaise: 90000, gstPaise: 16200, totalPaise: 106200 })
  })
  it('ITC only for a GSTIN buyer', () => {
    expect(priceDisplay({ pricePaise: 149900, discountBps: 0 }).itcPaise).toBeNull()
    expect(priceDisplay({ pricePaise: 149900, discountBps: 0, buyerHasGstin: true }).itcPaise).toBe(26982)
  })
})
