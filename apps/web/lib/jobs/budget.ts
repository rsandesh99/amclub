/**
 * Audit M38 (ADR 027) — a money cron works in bounded batches inside a time
 * budget. It stops taking new items once the budget is spent, leaving `reserve`
 * seconds before the route's `maxDuration` to finish the item in hand and
 * record its heartbeat. Whatever it leaves is picked up by the next run: every
 * item is guarded on the state it expects, so a re-run is safe.
 */
export interface TimeBudget {
  /** True once no new item should be started. */
  spent(): boolean
}

export function timeBudget(maxDurationSeconds: number, reserveSeconds = 60): TimeBudget {
  const deadline = Date.now() + Math.max(5, maxDurationSeconds - reserveSeconds) * 1000
  return { spent: () => Date.now() >= deadline }
}

/** No budget: callers that are not crons (ops actions, rigs) run to the end of their bounded batch. */
export const UNBOUNDED: TimeBudget = { spent: () => false }
