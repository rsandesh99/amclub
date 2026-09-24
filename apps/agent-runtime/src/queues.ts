/**
 * THE queue registry (audit M32). Every pg-boss queue the worker sends to,
 * works or schedules is declared here, and startWorker creates every entry
 * before the first send. pg-boss v10 `send` to a queue that was never created
 * inserts nothing and returns null — which is how `agent.munshi.growth` was
 * silently dropped every week. `queues.test.ts` asserts that every
 * send / work / schedule in src names a registry entry and that each one was
 * created, so a queue added the old way fails the test.
 */

export interface QueuePolicy {
  retryLimit?: number
  retryDelay?: number
}

export interface QueueDef {
  name: string
  policy: QueuePolicy
}

const q = (name: string, policy: QueuePolicy = {}): QueueDef => ({ name, policy })

/** One retry policy per family; a queue's policy never touches another agent's. */
const DOSSIER_RETRY = { retryLimit: 2, retryDelay: 300 } as const
const ONE_RETRY = { retryLimit: 1, retryDelay: 60 } as const
const NO_RETRY = { retryLimit: 0 } as const

export const Q = {
  /** S0.1 — the generic agent.run queue (the hello smoke agent). */
  run: q('agent.run'),
  /** S0.5 — one job per stored inbound wa_messages row (job id = the message id: one job per message, ever). */
  waInbound: q('wa.inbound', { retryLimit: 2, retryDelay: 30 }),
  /** Audit M33 — every minute: re-enqueue inbound messages stored but never processed. */
  waSweep: q('wa.inbound.sweep', NO_RETRY),
  /** S1.4 — payout dossiers: 2 × 300 s (no retry storms). */
  dossier: q('agent.payout_dossier', DOSSIER_RETRY),
  /** S1.7 — dispute triages: the dossier's policy. */
  triage: q('agent.dispute_triage', DOSSIER_RETRY),
  /** S1.6 — onboarding turns: one retry after 60 s (idempotent through guarded state updates). */
  onboarding: q('agent.onboarding', ONE_RETRY),
  /** S2.2 — Munshi: the scan and the follow-up never retry (the next cron tick is the retry); a decide retries once. */
  munshiScan: q('agent.munshi.scan', NO_RETRY),
  munshiFollowup: q('agent.munshi.followup', NO_RETRY),
  munshiDecide: q('agent.munshi.decide', ONE_RETRY),
  /** S2.4 — the weekly growth nudge (was never created before audit M32). */
  munshiGrowth: q('agent.munshi.growth', NO_RETRY),
  /** S2.3 — support turns / nudge decisions: one retry after 60 s. */
  supportReply: q('agent.support.reply', ONE_RETRY),
  supportDecide: q('agent.support.decide', ONE_RETRY),
  /** S3.1 — procurement: a turn and a decision retry once; the watch never retries. */
  procurementTurn: q('agent.procurement.turn', ONE_RETRY),
  procurementDecide: q('agent.procurement.decide', ONE_RETRY),
  procurementWatch: q('agent.procurement.watch', NO_RETRY),
} as const satisfies Record<string, QueueDef>

export type QueueKey = keyof typeof Q

export const ALL_QUEUES: readonly QueueDef[] = Object.values(Q)

/** The subset of the pg-boss API the worker uses — injectable so tests prove the registry without a database. */
export interface WorkerBoss {
  start(): Promise<unknown>
  stop(opts?: unknown): Promise<unknown>
  on(event: 'error', handler: (e: Error) => void): unknown
  createQueue(name: string, options?: Record<string, unknown>): Promise<unknown>
  getQueue(name: string): Promise<unknown>
  work<T>(name: string, handler: (jobs: Array<{ id: string; data: T }>) => Promise<unknown>): Promise<unknown>
  send(name: string, data: object, options?: Record<string, unknown>): Promise<string | null>
  schedule(name: string, cron: string, data?: object, options?: Record<string, unknown>): Promise<unknown>
}

/** Create every registry queue (idempotent in pg-boss: an existing queue is left as is). */
export async function createAllQueues(boss: Pick<WorkerBoss, 'createQueue'>): Promise<void> {
  for (const def of ALL_QUEUES) await boss.createQueue(def.name, { name: def.name, ...def.policy })
}

/**
 * pg-boss `send` returns null for two different reasons: a singleton / id
 * collision (the job already exists — expected) or no queue row (the job was
 * dropped — a bug). Callers that pass singleton options ask this to tell them
 * apart; anything else that returns null is an error.
 */
export async function explainNullSend(boss: Pick<WorkerBoss, 'getQueue'>, name: string): Promise<'collision' | 'queue_missing'> {
  const queue = await boss.getQueue(name).catch(() => null)
  return queue ? 'collision' : 'queue_missing'
}
