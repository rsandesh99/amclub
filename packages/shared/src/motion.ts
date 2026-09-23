/**
 * FRONTEND.md §3.1 / PRD Experience v3 E13 FR-13.5 — the signature motions'
 * timing, one table for web and mobile. Each budget is the hard ceiling from
 * the PRD (Gold Stamp ≤ 700 ms, Paisa Moment ≤ 900 ms on checkout); the
 * phases must fit inside it. Reduced motion skips straight to the final state.
 */
export const MOTION_BUDGET_MS = { goldStamp: 700, paisaMoment: 900 } as const

/** Gold Stamp: press in (scale 1.25 → 0.94), the paper-indent settle (→ 1), one metallic sweep. */
export const GOLD_STAMP_PHASES_MS = { press: 220, settle: 160, sweep: 300 } as const
/** Paisa Moment: the coin drops and flips, lands as a tick, the amount fades up, then it hands back. */
export const PAISA_MOMENT_PHASES_MS = { drop: 320, land: 180, amount: 220, hold: 160 } as const

export const totalMs = (phases: Readonly<Record<string, number>>): number => Object.values(phases).reduce((a, b) => a + b, 0)
