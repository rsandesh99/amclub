import PgBoss from 'pg-boss'
import { runAgent } from '@amclub/agent-core'
import { helloAgent, type HelloInput } from './agents/hello/index'
import { payoutDossierAgent, type PayoutDossierInput } from './agents/payout-dossier/index'
import { listExpiredOnboardingSessions, runOnboardingTurn, type OnboardingTurn } from './agents/onboarding/index'
import { admin, buildDeps, buildOnboardingDeps } from './deps'
import { handleWaInbound } from './whatsapp/inbound'
import { RUNTIME_ENV } from './env'

/**
 * The persistent job worker ADR-001 deferred (ADR-009 §1). One pg-boss queue,
 * `agent.run`, dispatches to a registered agent by name. Scheduled/proactive
 * agents enqueue here; S0.1 ships the `hello` smoke agent, S1.4 adds the
 * Payout-Evidence agent on its own queue (its retry policy must never touch
 * other agents).
 */

const QUEUE = 'agent.run'
/** S0.5 — inbound WhatsApp messages, one job per stored wa_messages row. */
const WA_QUEUE = 'wa.inbound'
/** S1.4 — payout dossiers: retryLimit 2, retryDelay 300 s (no retry storms). */
const DOSSIER_QUEUE = 'agent.payout_dossier'
const DOSSIER_RETRY = { retryLimit: 2, retryDelay: 300 } as const
/** S1.6 — onboarding interview turns: one retry after 60 s (a turn is idempotent through guarded state updates). */
const ONBOARDING_QUEUE = 'agent.onboarding'
const ONBOARDING_RETRY = { retryLimit: 1, retryDelay: 60 } as const

/**
 * Run failures that retrying cannot fix: the web flag is off, the user has no
 * grant, a budget/step cap, authz, or the evidence read was refused (4xx).
 * Everything else (network, 5xx, DB) is thrown so pg-boss retries per queue.
 */
const NO_RETRY = /^(agent_disabled|no_\w+_grant|budget_|step_budget|tool_not_allowed|tool_out_of_scope|taint_violation|evidence_read_failed:4|session_terminal|session_not_found|message_not_found|message_conversation_mismatch|no_draft_to_confirm)/

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
  await boss.createQueue(WA_QUEUE)
  await boss.createQueue(DOSSIER_QUEUE, { name: DOSSIER_QUEUE, ...DOSSIER_RETRY })
  await boss.createQueue(ONBOARDING_QUEUE, { name: ONBOARDING_QUEUE, ...ONBOARDING_RETRY })
  const deps = buildDeps()

  await boss.work<RunJob>(QUEUE, async (jobs) => {
    for (const job of jobs) {
      const { agent, open, input } = job.data
      if (agent === 'hello') {
        await runAgent(helloAgent, deps, { ...open, jobId: job.id }, input as HelloInput)
      } else {
        console.warn(`[worker] unknown agent '${agent}' — skipping job ${job.id}`)
      }
    }
  })
  await boss.work<RunJob>(DOSSIER_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const { open, input } = job.data
      const r = await runAgent(payoutDossierAgent, deps, { ...open, jobId: job.id }, input as PayoutDossierInput)
      if (r.status === 'failed') {
        if (NO_RETRY.test(r.error)) {
          console.warn(`[worker] payout_dossier run ${r.runId} failed terminally: ${r.error}`)
          continue
        }
        throw new Error(`payout_dossier run ${r.runId} failed: ${r.error}`) // → pg-boss retry (2 × 300 s)
      }
    }
  })
  await boss.work<OnboardingTurn>(ONBOARDING_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const r = await runOnboardingTurn(await buildOnboardingDeps(), { ...job.data, jobId: job.id })
      if (r.status === 'failed') {
        if (NO_RETRY.test(r.error)) {
          console.warn(`[worker] onboarding turn ${job.data.kind}/${job.data.sessionId} failed terminally: ${r.error}`)
          continue
        }
        throw new Error(`onboarding run ${r.runId ?? '-'} failed: ${r.error}`) // → pg-boss retry (1 × 60 s)
      }
    }
  })
  await boss.work<{ messageId: string }>(WA_QUEUE, async (jobs) => {
    for (const job of jobs) await handleWaInbound(job.data.messageId, { enqueueOnboarding: enqueueOnboardingJob })
  })
  console.log(`[worker] pg-boss started on queues ${QUEUE}, ${DOSSIER_QUEUE}, ${ONBOARDING_QUEUE}, ${WA_QUEUE}`)
}

/** S1.6 — one onboarding turn (start | message | expire) on its own queue. */
export async function enqueueOnboardingJob(turn: OnboardingTurn): Promise<string | null> {
  if (!boss) return null
  return boss.send(ONBOARDING_QUEUE, turn, { ...ONBOARDING_RETRY })
}

/** Enqueue a run for an agent by name (called by POST /internal/jobs/:name). */
export async function enqueueJob(agent: string, data: unknown): Promise<string | null> {
  if (!boss) throw new Error('worker not started (DATABASE_URL unset)')
  if (agent === 'onboarding') {
    // The web start route: { kind:'start', sessionId }. Validated shape only.
    const t = data as Partial<OnboardingTurn>
    if ((t.kind !== 'start' && t.kind !== 'message' && t.kind !== 'expire') || typeof t.sessionId !== 'string') throw new Error('bad_onboarding_turn')
    return enqueueOnboardingJob({ kind: t.kind, sessionId: t.sessionId, ...(t.messageId ? { messageId: t.messageId } : {}) })
  }
  if (agent === 'onboarding.expire') {
    // The web cron: enumerate sessions past expires_at and enqueue one expire turn each.
    const ids = await listExpiredOnboardingSessions(admin())
    for (const id of ids) await enqueueOnboardingJob({ kind: 'expire', sessionId: id })
    return `expire:${ids.length}`
  }
  const payload = { agent, ...(data as object) } as RunJob
  if (agent === 'payout_dossier') return boss.send(DOSSIER_QUEUE, payload, { ...DOSSIER_RETRY })
  return boss.send(QUEUE, payload)
}

/** Enqueue an inbound WhatsApp message for the wa.inbound job (called by the webhook). */
export async function enqueueWaInbound(messageId: string): Promise<string | null> {
  if (!boss) return null // worker disabled (no DATABASE_URL): the message is stored; nothing replies
  return boss.send(WA_QUEUE, { messageId })
}

export async function stopWorker(): Promise<void> {
  if (boss) await boss.stop()
  boss = null
}
