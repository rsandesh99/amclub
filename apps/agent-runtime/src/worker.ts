import PgBoss from 'pg-boss'
import { runAgent } from '@amclub/agent-core'
import { helloAgent, type HelloInput } from './agents/hello/index'
import { payoutDossierAgent, type PayoutDossierInput } from './agents/payout-dossier/index'
import { listExpiredOnboardingSessions, runOnboardingTurn, type OnboardingTurn } from './agents/onboarding/index'
import { disputeTriageAgent, type DisputeTriageInput } from './agents/dispute-triage/index'
import { runMunshiDecide, runMunshiFollowup, runMunshiGrowth, runMunshiScan, type MunshiDecideJob } from './agents/munshi/index'
import { runSupportDecide, runSupportReply, type SupportDecideJob, type SupportReplyJob } from './agents/support/index'
import { decideProcurement, runProcurementTurn, runProcurementWatch, type ProcurementDecideJob, type ProcurementTurnJob } from './agents/procurement/index'
import { admin, buildDeps, buildMunshiDeps, buildOnboardingDeps, buildProcurementDeps, buildSupportDeps } from './deps'
import { handleWaInbound, sweepUnprocessedInbound, type SweepResult } from './whatsapp/inbound'
import { RUNTIME_ENV } from './env'
import { ALL_QUEUES, Q, createAllQueues, explainNullSend, type WorkerBoss } from './queues'

/**
 * The persistent job worker ADR-001 deferred (ADR-009 §1). Every queue lives in
 * the registry (`queues.ts`, audit M32) and is created before the first send;
 * S0.1 ships the `hello` smoke agent on `agent.run`, and each later agent has its
 * own queue so its retry policy never touches another agent's.
 *
 * Audit M33: the process exits when the worker cannot start (Fly restarts the
 * machine), /health reports the worker state, and `wa.inbound.sweep` re-enqueues
 * inbound messages that were stored but never processed.
 */

/**
 * Run failures that retrying cannot fix: the web flag is off, the user has no
 * grant, a budget/step cap, authz, or the evidence read was refused (4xx).
 * Everything else (network, 5xx, DB) is thrown so pg-boss retries per queue.
 */
const NO_RETRY = /^(agent_disabled|no_\w+_grant|budget_|step_budget|tool_not_allowed|tool_out_of_scope|taint_violation|evidence_read_failed:4|session_terminal|session_not_found|message_not_found|message_conversation_mismatch|no_draft_to_confirm|dispute_resolved|dispute_not_found|dispute_read_failed:4|triage_cap|draft_gone|grant_revoked|daily_cap|decision_failed:4|ticket_open|conversation_not_found|no_profile|empty_message|run_gone|session_closed|grant_revoked|proposal_cap|session_insert_failed)/

interface RunJob {
  agent: string
  open: { userId: string; surface: string; subjectType?: string | null; subjectId?: string | null }
  input: unknown
}

/** What /health reports about the worker (audit M33). */
export interface WorkerHealth {
  state: 'disabled' | 'starting' | 'running' | 'failed' | 'stopped'
  databaseUrl: boolean
  since: string
  queues: number
  lastError: { at: string; message: string } | null
  lastSweep: (SweepResult & { at: string }) | null
}

let boss: WorkerBoss | null = null
const health: WorkerHealth = { state: 'disabled', databaseUrl: !!RUNTIME_ENV.DATABASE_URL, since: new Date().toISOString(), queues: 0, lastError: null, lastSweep: null }

export function workerHealth(): WorkerHealth {
  return { ...health, lastError: health.lastError ? { ...health.lastError } : null, lastSweep: health.lastSweep ? { ...health.lastSweep } : null }
}

function setState(state: WorkerHealth['state']): void {
  health.state = state
  health.since = new Date().toISOString()
}

/** Every minute (pg-boss cron): the sweep of inbound messages stored but never processed. */
const SWEEP_CRON = '* * * * *'

export interface StartWorkerOptions {
  /** Tests inject a fake pg-boss; production builds one from DATABASE_URL. */
  boss?: WorkerBoss
}

export async function startWorker(opts: StartWorkerOptions = {}): Promise<void> {
  if (!opts.boss && !RUNTIME_ENV.DATABASE_URL) {
    console.warn('[worker] DATABASE_URL unset — job worker disabled (/health reports worker.state = disabled)')
    setState('disabled')
    return
  }
  setState('starting')
  const b: WorkerBoss = opts.boss ?? (new PgBoss({ connectionString: RUNTIME_ENV.DATABASE_URL, schema: 'pgboss' }) as unknown as WorkerBoss)
  b.on('error', (e: Error) => {
    health.lastError = { at: new Date().toISOString(), message: e.message.slice(0, 300) }
    console.error('[worker] pg-boss error', e)
  })
  try {
    await b.start()
    await createAllQueues(b)
    health.queues = ALL_QUEUES.length
    boss = b
    await registerHandlers(b)
    await b.schedule(Q.waSweep.name, SWEEP_CRON, {}, { tz: 'UTC' })
  } catch (e) {
    setState('failed')
    health.lastError = { at: new Date().toISOString(), message: (e as Error).message.slice(0, 300) }
    boss = null
    throw e
  }
  setState('running')
  console.log(`[worker] pg-boss started; queues: ${ALL_QUEUES.map((q) => q.name).join(', ')}`)
}

async function registerHandlers(b: WorkerBoss): Promise<void> {
  const deps = buildDeps()

  await b.work<RunJob>(Q.run.name, async (jobs) => {
    for (const job of jobs) {
      const { agent, open, input } = job.data
      if (agent === 'hello') {
        await runAgent(helloAgent, deps, { ...open, jobId: job.id }, input as HelloInput)
      } else {
        console.warn(`[worker] unknown agent '${agent}' — skipping job ${job.id}`)
      }
    }
  })
  await b.work<RunJob>(Q.dossier.name, async (jobs) => {
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
  await b.work<RunJob>(Q.triage.name, async (jobs) => {
    for (const job of jobs) {
      const { open, input } = job.data
      const r = await runAgent(disputeTriageAgent, deps, { ...open, jobId: job.id }, input as DisputeTriageInput)
      if (r.status === 'failed') {
        if (NO_RETRY.test(r.error)) {
          console.warn(`[worker] dispute_triage run ${r.runId} failed terminally: ${r.error}`)
          continue
        }
        throw new Error(`dispute_triage run ${r.runId} failed: ${r.error}`) // → pg-boss retry (2 × 300 s)
      }
    }
  })
  await b.work<OnboardingTurn>(Q.onboarding.name, async (jobs) => {
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
  await b.work<{ kind: 'scan' }>(Q.munshiScan.name, async () => {
    const r = await runMunshiScan(buildMunshiDeps())
    if (r.status === 'failed') console.warn(`[worker] munshi.scan: ${r.error}`)
    else console.log('[worker] munshi.scan', JSON.stringify(r.detail))
  })
  await b.work<{ kind: 'followup' }>(Q.munshiFollowup.name, async () => {
    const r = await runMunshiFollowup(buildMunshiDeps())
    if (r.status === 'failed') console.warn(`[worker] munshi.followup: ${r.error}`)
    else console.log('[worker] munshi.followup', JSON.stringify(r.detail))
  })
  await b.work<{ kind: 'growth' }>(Q.munshiGrowth.name, async () => {
    const r = await runMunshiGrowth(buildMunshiDeps())
    if (r.status === 'failed') console.warn(`[worker] munshi.growth: ${r.error}`)
    else console.log('[worker] munshi.growth', JSON.stringify(r.detail))
  })
  await b.work<MunshiDecideJob>(Q.munshiDecide.name, async (jobs) => {
    for (const job of jobs) {
      const r = await runMunshiDecide(buildMunshiDeps(), { ...job.data, jobId: job.id })
      if (r.status === 'failed') {
        if (NO_RETRY.test(r.error)) {
          console.warn(`[worker] munshi.decide ${job.data.action}/${job.data.runId} failed terminally: ${r.error}`)
          continue
        }
        throw new Error(`munshi.decide ${job.data.runId} failed: ${r.error}`) // → pg-boss retry (1 × 60 s)
      }
    }
  })
  await b.work<SupportReplyJob>(Q.supportReply.name, async (jobs) => {
    for (const job of jobs) {
      const r = await runSupportReply(buildSupportDeps(), { ...job.data, jobId: job.id })
      if (r.status === 'failed') {
        if (NO_RETRY.test(r.error)) {
          console.warn(`[worker] support.reply ${job.data.messageId} failed terminally: ${r.error}`)
          continue
        }
        throw new Error(`support.reply ${job.data.messageId} failed: ${r.error}`) // → pg-boss retry (1 × 60 s)
      }
    }
  })
  await b.work<SupportDecideJob>(Q.supportDecide.name, async (jobs) => {
    for (const job of jobs) {
      const r = await runSupportDecide(buildSupportDeps(), { ...job.data, jobId: job.id })
      if (r.status === 'failed') {
        if (NO_RETRY.test(r.error)) {
          console.warn(`[worker] support.decide ${job.data.runId} failed terminally: ${r.error}`)
          continue
        }
        throw new Error(`support.decide ${job.data.runId} failed: ${r.error}`)
      }
    }
  })
  await b.work<ProcurementTurnJob>(Q.procurementTurn.name, async (jobs) => {
    for (const job of jobs) {
      const r = await runProcurementTurn(buildProcurementDeps(), { ...job.data, jobId: job.id })
      if (r.status === 'failed') {
        if (NO_RETRY.test(r.error)) {
          console.warn(`[worker] procurement.turn ${job.data.messageId ?? job.data.turnId ?? '-'} failed terminally: ${r.error}`)
          continue
        }
        throw new Error(`procurement.turn failed: ${r.error}`) // → pg-boss retry (1 × 60 s)
      }
    }
  })
  await b.work<ProcurementDecideJob>(Q.procurementDecide.name, async (jobs) => {
    for (const job of jobs) {
      const r = await decideProcurement(buildProcurementDeps(), { ...job.data, jobId: job.id })
      if (r.status === 'failed') {
        if (NO_RETRY.test(r.error)) {
          console.warn(`[worker] procurement.decide ${job.data.action}/${job.data.runId} failed terminally: ${r.error}`)
          continue
        }
        throw new Error(`procurement.decide ${job.data.runId} failed: ${r.error}`)
      }
    }
  })
  await b.work<{ kind: 'watch' }>(Q.procurementWatch.name, async () => {
    const r = await runProcurementWatch(buildProcurementDeps())
    if (r.status === 'failed') console.warn(`[worker] procurement.watch: ${r.error}`)
    else console.log('[worker] procurement.watch', JSON.stringify(r.detail))
  })
  await b.work<{ messageId: string }>(Q.waInbound.name, async (jobs) => {
    for (const job of jobs) await handleWaInbound(job.data.messageId, inboundHooks)
  })
  await b.work<Record<string, never>>(Q.waSweep.name, async () => {
    const r = await sweepUnprocessedInbound(admin(), enqueueWaInbound)
    health.lastSweep = { ...r, at: new Date().toISOString() }
    if (r.error) console.error('[worker] wa.inbound.sweep', r.error)
    else if (r.requeued > 0 || r.stale > 0) console.warn('[worker] wa.inbound.sweep', JSON.stringify(r))
  })
}

/** The hooks the wa.inbound job hands to the dispatcher (no import cycle). */
const inboundHooks = {
  enqueueOnboarding: (turn: { kind: 'start' | 'message'; sessionId: string; messageId?: string }) => enqueueOnboardingJob(turn),
  enqueueMunshiDecide: (job: Omit<MunshiDecideJob, 'kind'>) => enqueueMunshiDecideJob(job),
  enqueueSupportReply: (job: { conversationId: string; messageId: string }) => enqueueSupportReplyJob(job),
  enqueueSupportDecide: (job: { runId: string; messageId: string; action: 'yes' | 'no' }) => enqueueSupportDecideJob(job),
  enqueueProcurementTurn: (job: Omit<ProcurementTurnJob, 'kind'>) => enqueueProcurementTurnJob(job),
  enqueueProcurementDecide: (job: Omit<ProcurementDecideJob, 'kind'>) => enqueueProcurementDecideJob(job),
}

/**
 * A send that must produce a job. pg-boss returns null when no job was inserted:
 * with singleton options that is a collision (expected — `deduped`); otherwise,
 * or when the queue row is missing, the job was DROPPED — thrown, never silent (audit M32).
 */
async function sendOrThrow(name: string, data: object, options: Record<string, unknown>, singleton = false): Promise<{ jobId: string | null; deduped: boolean }> {
  if (!boss) throw new Error('worker_not_started')
  const jobId = await boss.send(name, data, options) // queue-registry: forwarded (every caller passes Q.<key>.name)
  if (jobId) return { jobId, deduped: false }
  if (singleton && (await explainNullSend(boss, name)) === 'collision') return { jobId: null, deduped: true }
  throw new Error(`enqueue_dropped:${name}`)
}

/** S1.6 — one onboarding turn (start | message | expire) on its own queue. */
export async function enqueueOnboardingJob(turn: OnboardingTurn): Promise<string | null> {
  if (!boss) return null
  return (await sendOrThrow(Q.onboarding.name, turn, { ...Q.onboarding.policy })).jobId
}

/** S2.3 — one support turn (an inbound message) / one nudge decision. */
export async function enqueueSupportReplyJob(job: { conversationId: string; messageId: string }): Promise<string | null> {
  if (!boss) return null
  return (await sendOrThrow(Q.supportReply.name, { kind: 'reply', ...job }, { ...Q.supportReply.policy })).jobId
}
export async function enqueueSupportDecideJob(job: { runId: string; messageId: string; action: 'yes' | 'no' }): Promise<string | null> {
  if (!boss) return null
  return (await sendOrThrow(Q.supportDecide.name, { kind: 'decide', ...job }, { ...Q.supportDecide.policy })).jobId
}

/** S3.1 — one procurement turn / one procurement decision. */
export async function enqueueProcurementTurnJob(job: Omit<ProcurementTurnJob, 'kind'>): Promise<string | null> {
  if (!boss) return null
  return (await sendOrThrow(Q.procurementTurn.name, { kind: 'turn', ...job }, { ...Q.procurementTurn.policy })).jobId
}
export async function enqueueProcurementDecideJob(job: Omit<ProcurementDecideJob, 'kind'>): Promise<string | null> {
  if (!boss) return null
  return (await sendOrThrow(Q.procurementDecide.name, { kind: 'decide', ...job }, { ...Q.procurementDecide.policy })).jobId
}

/** S2.2 — one Munshi decision (a button tap, an utterance, or a buttons re-send) on its own queue. */
export async function enqueueMunshiDecideJob(job: Omit<MunshiDecideJob, 'kind'>): Promise<string | null> {
  if (!boss) return null
  return (await sendOrThrow(Q.munshiDecide.name, { kind: 'decide', ...job }, { ...Q.munshiDecide.policy })).jobId
}

/** POST /internal/jobs/:name → { jobId, deduped }: deduped = an overlapping cron tick collapsed onto an existing job. */
export interface EnqueueOutcome {
  jobId: string | null
  deduped: boolean
}

/** Enqueue a run for an agent by name (called by POST /internal/jobs/:name). Throws when nothing was enqueued. */
export async function enqueueJob(agent: string, data: unknown): Promise<EnqueueOutcome> {
  if (!boss) throw new Error('worker_not_started')
  // S2.2 / S2.4 / S3.1 — the web crons: one job per tick (singletonKey collapses overlapping ticks).
  if (agent === 'munshi.scan') return sendOrThrow(Q.munshiScan.name, { kind: 'scan' }, { ...Q.munshiScan.policy, singletonKey: 'munshi.scan', singletonSeconds: 600 }, true)
  if (agent === 'munshi.followup') return sendOrThrow(Q.munshiFollowup.name, { kind: 'followup' }, { ...Q.munshiFollowup.policy, singletonKey: 'munshi.followup', singletonSeconds: 1800 }, true)
  if (agent === 'munshi.growth') return sendOrThrow(Q.munshiGrowth.name, { kind: 'growth' }, { ...Q.munshiGrowth.policy, singletonKey: 'munshi.growth', singletonSeconds: 3600 }, true)
  // S3.1 — the watcher (web cron, every 15 min; overlapping ticks collapse) and a web / mobile composer turn (the web
  // stored the buyer's turn; the runtime runs the SAME turn engine as WhatsApp). Validated shapes only.
  if (agent === 'procurement.watch') return sendOrThrow(Q.procurementWatch.name, { kind: 'watch' }, { ...Q.procurementWatch.policy, singletonKey: 'procurement.watch', singletonSeconds: 600 }, true)
  if (agent === 'procurement.turn') {
    const t = data as Partial<ProcurementTurnJob>
    const uuid = /^[0-9a-f-]{36}$/i
    if (typeof t.userId !== 'string' || !uuid.test(t.userId) || typeof t.turnId !== 'string' || !uuid.test(t.turnId) || (t.sessionId !== null && t.sessionId !== undefined && !uuid.test(String(t.sessionId))) || (t.surface !== 'web' && t.surface !== 'mobile')) throw new Error('bad_procurement_turn')
    const forced = t.forced && typeof t.forced === 'object' ? { ...(typeof t.forced.label === 'string' && /^[A-G]$/.test(t.forced.label) ? { label: t.forced.label } : {}), ...(t.forced.sessionChoice === 'new' || t.forced.sessionChoice === 'current' ? { sessionChoice: t.forced.sessionChoice } : {}) } : null
    return { jobId: await enqueueProcurementTurnJob({ userId: t.userId, surface: t.surface, sessionId: t.sessionId ?? null, turnId: t.turnId, ...(forced && Object.keys(forced).length ? { forced } : {}) }), deduped: false }
  }
  if (agent === 'procurement.decide') {
    // the web / mobile tap (the web route verified the run is the open proposal of the buyer's own session)
    const d = data as Partial<ProcurementDecideJob>
    const uuid = /^[0-9a-f-]{36}$/i
    if (typeof d.runId !== 'string' || !uuid.test(d.runId) || typeof d.userId !== 'string' || !uuid.test(d.userId) || (d.action !== 'ok' && d.action !== 'edit' && d.action !== 'no')) throw new Error('bad_procurement_decide')
    return { jobId: await enqueueProcurementDecideJob({ runId: d.runId, userId: d.userId, action: d.action, via: 'web' }), deduped: false }
  }
  if (agent === 'onboarding') {
    // The web start route: { kind:'start', sessionId }. Validated shape only.
    const t = data as Partial<OnboardingTurn>
    if ((t.kind !== 'start' && t.kind !== 'message' && t.kind !== 'expire') || typeof t.sessionId !== 'string') throw new Error('bad_onboarding_turn')
    return { jobId: await enqueueOnboardingJob({ kind: t.kind, sessionId: t.sessionId, ...(t.messageId ? { messageId: t.messageId } : {}) }), deduped: false }
  }
  if (agent === 'onboarding.expire') {
    // The web cron: enumerate sessions past expires_at and enqueue one expire turn each.
    const ids = await listExpiredOnboardingSessions(admin())
    for (const id of ids) await enqueueOnboardingJob({ kind: 'expire', sessionId: id })
    return { jobId: `expire:${ids.length}`, deduped: false }
  }
  const payload = { agent, ...(data as object) } as RunJob
  if (agent === 'payout_dossier') return sendOrThrow(Q.dossier.name, payload, { ...Q.dossier.policy })
  if (agent === 'dispute_triage') return sendOrThrow(Q.triage.name, payload, { ...Q.triage.policy })
  return sendOrThrow(Q.run.name, payload, {})
}

/**
 * Enqueue an inbound WhatsApp message for the wa.inbound job (the webhook and the
 * sweep). The job id IS the message id, so a message has at most one job while
 * pg-boss keeps it (≥ 12 h): a replayed webhook or the sweep never double-process.
 * Returns the job id when a job was created, null when one already exists or the
 * worker is not running (the message is stored; the sweep picks it up).
 */
export async function enqueueWaInbound(messageId: string): Promise<string | null> {
  if (!boss) return null
  return boss.send(Q.waInbound.name, { messageId }, { id: messageId, ...Q.waInbound.policy })
}

export async function stopWorker(): Promise<void> {
  if (boss) await boss.stop()
  boss = null
  setState('stopped')
}
