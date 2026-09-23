import { describe, expect, it } from 'vitest'
import { summarizeProviderOrders } from '../provider-stats'
import { ORDER_DONE_STATUSES, ORDER_IN_FLIGHT_STATUSES, ORDER_STATUSES } from '../state-machines'

describe('summarizeProviderOrders (E0 / U8)', () => {
  it('counts in-flight and done orders; earnings only from done ones', () => {
    const s = summarizeProviderOrders([
      { status: 'placed', provider_earning_paise: 100_00 },
      { status: 'in_progress', provider_earning_paise: 200_00 },
      { status: 'completed', provider_earning_paise: 300_00 },
      { status: 'reviewed', provider_earning_paise: '40000' },
      { status: 'disputed', provider_earning_paise: 500_00 },
      { status: 'refunded', provider_earning_paise: 600_00 },
    ])
    expect(s).toEqual({ activeCount: 2, completedCount: 2, earningsPaise: 300_00 + 400_00 })
  })
  it('reviewed orders stay counted as completed (the web page used to drop them)', () => {
    expect(summarizeProviderOrders([{ status: 'reviewed', provider_earning_paise: 1 }]).completedCount).toBe(1)
  })
  it('the two sets are disjoint and use only real statuses', () => {
    for (const s of [...ORDER_IN_FLIGHT_STATUSES, ...ORDER_DONE_STATUSES]) expect(ORDER_STATUSES).toContain(s)
    for (const s of ORDER_IN_FLIGHT_STATUSES) expect(ORDER_DONE_STATUSES).not.toContain(s)
  })
})
