import { describe, expect, it } from 'vitest'
import { goodsSpecForSeller } from '../mart/goods'

describe('goodsSpecForSeller (audit M4)', () => {
  const spec = {
    item: 'MS angle 40x40', qty: 200, unit: 'kg', spec: [{ k: 'grade', v: 'E250' }],
    delivery: { contact_name: 'Asha Rao', contact_phone: '+919812345678', address: '12, Industrial Estate, Balanagar', city: 'Hyderabad', state: 'TS', pincode: '500037', pickup: false },
  }

  it('keeps where the goods go and drops who and the street address', () => {
    const out = goodsSpecForSeller(spec) as { delivery: Record<string, unknown>; item: string; qty: number }
    expect(out.item).toBe('MS angle 40x40')
    expect(out.qty).toBe(200)
    expect(out.delivery).toEqual({ city: 'Hyderabad', state: 'TS', pincode: '500037', pickup: false })
    expect(JSON.stringify(out)).not.toMatch(/Asha|9812345678|Balanagar/)
  })

  it('never mutates the stored spec', () => {
    goodsSpecForSeller(spec)
    expect(spec.delivery.contact_name).toBe('Asha Rao')
  })

  it('passes through a spec without delivery and refuses non-objects', () => {
    expect(goodsSpecForSeller({ item: 'x', qty: 1 })).toEqual({ item: 'x', qty: 1 })
    expect(goodsSpecForSeller(null)).toBeNull()
    expect(goodsSpecForSeller('nope')).toBeNull()
    expect(goodsSpecForSeller([1, 2])).toBeNull()
  })
})
