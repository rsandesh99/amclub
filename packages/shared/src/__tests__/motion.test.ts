import { describe, expect, it } from 'vitest'
import { GOLD_STAMP_PHASES_MS, MOTION_BUDGET_MS, PAISA_MOMENT_PHASES_MS, totalMs } from '../index'

describe('FR-13.5 — the signature motions fit their budgets', () => {
  it('Gold Stamp ≤ 700 ms, Paisa Moment ≤ 900 ms', () => {
    expect(totalMs(GOLD_STAMP_PHASES_MS)).toBeLessThanOrEqual(MOTION_BUDGET_MS.goldStamp)
    expect(totalMs(PAISA_MOMENT_PHASES_MS)).toBeLessThanOrEqual(MOTION_BUDGET_MS.paisaMoment)
  })
})
