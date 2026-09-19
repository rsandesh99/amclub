import PgBoss from 'pg-boss'
import { runAgent } from '@amclub/agent-core'
import { helloAgent, type HelloInput } from './agents/hello/index'
import { buildDeps } from './deps'
import { RUNTIME_ENV } from './env'

/**
 * The persistent job worker ADR-001 deferred (ADR-009 §1). One pg-boss queue,
 * `agent.run`, dispatches to a registered agent by name. Scheduled/proactive
 * agents (S1.4+) enqueue here; S0.1 ships only the `hello` smoke agent.
 */

const QUEUE = 'agent.run'

interface RunJob {
  agent: string
  open: { userId: string; surface: string; subjectType?: string | null; subjectId?: string | null }
  input: unknown
}

let boss: PgBoss | null = null

export async function startWorker(): Promise<void> {
  if (!RUNTIME_ENV.DATABASE_URL) {
    console.warn('[worker] DATABASE_URL unset — job worker disabled (health check still serves)')
    return
  }
  boss = new PgBoss({ connectionString: RUNTIME_ENV.DATABASE_URL, schema: 'pgboss' })
  boss.on('error', (e: Error) => console.error('[worker] pg-boss error', e))
  await boss.start()
  await boss.createQueue(QUEUE)
  const deps = buildDeps()

  await boss.work<RunJob>(QUEUE, async (jobs) => {
    for (const job of jobs) {
      const { agent, open, input } = job.data
      if (agent === 'hello') {
        await runAgent(helloAgent, deps, open, input as HelloInput)
      } else {
        console.warn(`[worker] unknown agent '${agent}' — skipping job ${job.id}`)
      }
    }
  })
  console.log(`[worker] pg-boss started on queue ${QUEUE}`)
}

/** Enqueue a run for an agent by name (called by POST /internal/jobs/:name). */
export async function enqueueJob(agent: string, data: unknown): Promise<string | null> {
  if (!boss) throw new Error('worker not started (DATABASE_URL unset)')
  const payload = { agent, ...(data as object) } as RunJob
  return boss.send(QUEUE, payload)
}

export async function stopWorker(): Promise<void> {
  if (boss) await boss.stop()
  boss = null
}
