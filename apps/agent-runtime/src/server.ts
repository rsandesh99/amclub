import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { HTTPException } from 'hono/http-exception'
import {
  AgentRun,
  extractRuntimeCredential,
  verifyRuntimeCredential,
  type RuntimeCredentialClaims,
} from '@amclub/agent-core'
import { agentToolNameSchema } from '@amclub/shared'
import { missingRuntimeConfig, RUNTIME_ENV } from './env'
import { buildRunContext } from './deps'
import { enqueueJob } from './worker'

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

app.get('/health', (c) => c.json({ ok: true, service: 'agent-runtime', missing: missingRuntimeConfig(), ts: Date.now() }))

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
  try {
    const outcome = await run.resume(toolParsed.data, body.final ?? {}, body.decisionId ? { decisionId: body.decisionId } : undefined)
    await run.complete()
    return c.json({ ok: true, outcome })
  } catch (e) {
    await run.fail((e as Error).message)
    return c.json({ error: (e as Error).message }, 400)
  }
})

// Enqueue a job (scheduled/proactive agents). S0.1 ships the `hello` smoke agent.
app.post('/internal/jobs/:name', async (c) => {
  requireRuntime(c.req.header('authorization'))
  const name = c.req.param('name')
  const data = (await c.req.json().catch(() => ({}))) as unknown
  try {
    const jobId = await enqueueJob(name, data)
    return c.json({ ok: true, jobId })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 503)
  }
})

export function startServer(): void {
  serve({ fetch: app.fetch, port: RUNTIME_ENV.PORT })
  console.log(`[server] agent-runtime listening on :${RUNTIME_ENV.PORT}`)
}

export { app }
