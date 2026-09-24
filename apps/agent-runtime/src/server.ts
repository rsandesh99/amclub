import { Hono } from 'hono'
import { finalizeMunshiRun } from './agents/munshi/index'
import { finalizeProcurementRun } from './agents/procurement/index'
import { sessionByOpenRun } from './agents/procurement/store'
import { admin, buildMunshiDeps, buildProcurementDeps } from './deps'
import { serve } from '@hono/node-server'
import { HTTPException } from 'hono/http-exception'
import { bodyLimit } from 'hono/body-limit'
import {
  AgentRun,
  extractRuntimeCredential,
  residencyPosture,
  verifyRuntimeCredential,
  type RuntimeCredentialClaims,
} from '@amclub/agent-core'
import { agentToolNameSchema } from '@amclub/shared'
import { missingRuntimeConfig, RUNTIME_ENV } from './env'
import { buildRunContext } from './deps'
import { enqueueJob, enqueueWaInbound, workerHealth } from './worker'
import { ingestWaWebhook, waVerifyChallenge } from './whatsapp/inbound'

/**
 * The runtime's HTTP surface (ADR-008 §2). Internal endpoints require the
 * runtime HMAC credential; there is no public API here — the runtime is a
 * client of /api/v1, not a second API of record. (S0.5 adds the WhatsApp
 * webhook.)
 */
const app = new Hono()

function requireRuntime(authorization: string | undefined): RuntimeCredentialClaims {
  const cred = extractRuntimeCredential(authorization ?? null)
  const claims = cred ? verifyRuntimeCredential(RUNTIME_ENV.RUNTIME_SECRET, cred) : null
  if (!claims) throw new HTTPException(401, { message: 'invalid_runtime_credential' })
  return claims
}

/**
 * Liveness + readiness (audit M33 / M23). `worker` = the pg-boss worker state,
 * whether DATABASE_URL is set, and the last inbound sweep (stored-but-unprocessed
 * WhatsApp messages); `residency` = the model gateway's data-residency posture.
 * 503 when agents are enabled but the worker is not running, so the platform
 * check turns red instead of the runtime silently storing messages nobody reads.
 */
app.get('/health', (c) => {
  const worker = workerHealth()
  const residency = residencyPosture()
  const degraded: string[] = []
  if (RUNTIME_ENV.AGENT_ENABLED && worker.state !== 'running') degraded.push(`worker_${worker.state}`)
  if (worker.lastSweep && (worker.lastSweep.requeued > 0 || worker.lastSweep.stale > 0)) degraded.push('inbound_unprocessed')
  if (worker.lastSweep?.error) degraded.push('inbound_sweep_failed')
  if (residency.mode === 'unconfigured') degraded.push('residency_unconfigured')
  const down = RUNTIME_ENV.AGENT_ENABLED && worker.state !== 'running'
  // public endpoint: states and counts only — error text, the waiver reason and hosts stay in the logs
  const body = {
    ok: !down && degraded.length === 0,
    service: 'agent-runtime',
    missing: missingRuntimeConfig(),
    degraded,
    worker: { state: worker.state, databaseUrl: worker.databaseUrl, since: worker.since, queues: worker.queues, lastErrorAt: worker.lastError?.at ?? null, lastSweep: worker.lastSweep },
    residency: { mode: residency.mode, required: residency.required },
    ts: Date.now(),
  }
  return c.json(body, down ? 503 : 200)
})

// Resume a parked run after the surface recorded an approval (the confirm gate
// verifies the ai_decisions row inside AgentRun.resume before calling the tool).
app.post('/internal/runs/:id/resume', async (c) => {
  const claims = requireRuntime(c.req.header('authorization'))
  const id = c.req.param('id')
  if (claims.runId !== id) throw new HTTPException(403, { message: 'run_mismatch' })
  const body = (await c.req.json().catch(() => ({}))) as { decisionId?: string; tool?: string; final?: Record<string, unknown> }
  const toolParsed = agentToolNameSchema.safeParse(body.tool)
  if (!toolParsed.success) return c.json({ error: 'bad_tool' }, 400)
  const run = new AgentRun(buildRunContext({ runId: id, userId: claims.userId, persona: claims.persona }))
  // S3.1 — a procurement proposal approved in the web / mobile mirror: after the route ran, the session + the buyer's reply.
  const procurement = !!(await sessionByOpenRun(admin(), id))
  // S2.2 — a Munshi run resumed from the web / mobile Approve: after the route ran, close the draft and tell the provider.
  const munshiTool = !procurement && (toolParsed.data === 'submit_quote' || toolParsed.data === 'ask_clarification' || toolParsed.data === 'reply_thread')
  try {
    const outcome = await run.resume(toolParsed.data, body.final ?? {}, body.decisionId ? { decisionId: body.decisionId } : undefined)
    await run.complete()
    if (munshiTool) await finalizeMunshiRun(buildMunshiDeps(), id, outcome.status === 'done' ? outcome.result : null, null, 'web').catch((e: Error) => console.warn('[munshi] finalize', e.message))
    if (procurement) await finalizeProcurementRun(buildProcurementDeps(), id, outcome.status === 'done' ? outcome.result : null, null, body.decisionId ?? null).catch((e: Error) => console.warn('[procurement] finalize', e.message))
    return c.json({ ok: true, outcome })
  } catch (e) {
    await run.fail((e as Error).message)
    if (munshiTool) await finalizeMunshiRun(buildMunshiDeps(), id, null, (e as Error).message, 'web').catch((err: Error) => console.warn('[munshi] finalize', err.message))
    if (procurement) await finalizeProcurementRun(buildProcurementDeps(), id, null, (e as Error).message, body.decisionId ?? null).catch((err: Error) => console.warn('[procurement] finalize', err.message))
    return c.json({ error: (e as Error).message }, 400)
  }
})

// Enqueue a job (scheduled/proactive agents). S0.1 ships the `hello` smoke agent.
app.post('/internal/jobs/:name', async (c) => {
  requireRuntime(c.req.header('authorization'))
  const name = c.req.param('name')
  const data = (await c.req.json().catch(() => ({}))) as unknown
  try {
    // audit M32: a send that inserted nothing (and was not a singleton collision) throws → 503, never a silent 200
    const { jobId, deduped } = await enqueueJob(name, data)
    return c.json({ ok: true, jobId, deduped })
  } catch (e) {
    console.error(`[server] enqueue ${name} failed`, (e as Error).message)
    return c.json({ error: (e as Error).message }, 503)
  }
})

// S0.5 — WhatsApp webhook. GET answers the Meta verify challenge; POST verifies
// the vendor signature, stores conversation + message idempotently and enqueues
// wa.inbound. Media is NOT downloaded here (audit M34): the job fetches it, with
// caps, only for a bound, opted-in number. 200 after a successful store; a store
// failure answers 5xx so the vendor retries (audit M33). No runtime credential
// here — the vendor signature IS the auth.
app.get('/webhooks/whatsapp', (c) => {
  const challenge = waVerifyChallenge(c.req.query())
  return challenge === null ? c.text('forbidden', 403) : c.text(challenge, 200)
})
// Vendor webhook bodies are a few KB; media arrives by reference, never inline.
const WEBHOOK_BODY_LIMIT = 256 * 1024
app.post('/webhooks/whatsapp', bodyLimit({ maxSize: WEBHOOK_BODY_LIMIT, onError: (c) => c.json({ error: 'too_large' }, 413) }), async (c) => {
  const raw = await c.req.text()
  const headers: Record<string, string | undefined> = {
    'x-hub-signature-256': c.req.header('x-hub-signature-256'),
    'x-interakt-secret': c.req.header('x-interakt-secret'),
  }
  const result = await ingestWaWebhook(raw, headers, enqueueWaInbound)
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json({ ok: true, stored: result.stored, statuses: result.statuses })
})

export function startServer(): void {
  serve({ fetch: app.fetch, port: RUNTIME_ENV.PORT })
  console.log(`[server] agent-runtime listening on :${RUNTIME_ENV.PORT}`)
}

export { app }
