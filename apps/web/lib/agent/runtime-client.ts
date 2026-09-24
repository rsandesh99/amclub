import 'server-only'
import type { AgentPersona } from '@amclub/shared'
import { signRuntimeCredential } from '@amclub/agent-core'
import { env } from '@/lib/env'

/**
 * Web → runtime job enqueue (S1.4 §4b). POSTs `${AGENT_RUNTIME_URL}/internal/jobs/<name>`
 * with the shared HMAC credential (the same `AMC-Runtime` scheme the runtime
 * presents to the token endpoint, in the other direction). Best-effort by
 * contract: 5 s timeout, never throws — a runtime outage must never break the
 * money path that called it. Returns { ok, jobId }.
 */

export const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * True when runtime agents can actually act: the web can queue their jobs
 * (AGENT_RUNTIME_URL + AGENT_RUNTIME_SECRET) and mint their delegated run
 * tokens (SUPABASE_JWT_SECRET). Without all three, shared `agentRunnable`
 * reads every RUNTIME_AGENTS entry as off.
 */
export function agentRuntimeReady(): boolean {
  return Boolean(env.AGENT_RUNTIME_URL && env.AGENT_RUNTIME_SECRET && env.SUPABASE_JWT_SECRET)
}

export interface EnqueueResult {
  ok: boolean
  jobId: string | null
  /** The runtime collapsed this onto an existing singleton job (an overlapping cron tick) — nothing new was queued. */
  deduped?: boolean
  /** Why it did not enqueue (not_configured | http_<status> | <error name>). */
  reason?: string
}

/**
 * Audit M32 — what a cron heartbeat records: `enqueued` only when the runtime
 * returned a job id (a 200 with no job used to read as healthy while the weekly
 * growth job was silently dropped); `deduped` when an overlapping tick collapsed.
 */
export function cronEnqueueOutcome(r: EnqueueResult): { enqueued: boolean; jobId: string | null; deduped: boolean; reason: string | null } {
  const enqueued = r.ok && r.jobId != null
  return { enqueued, jobId: r.jobId, deduped: r.deduped === true, reason: r.reason ?? (r.ok && !enqueued && r.deduped !== true ? 'no_job_id' : null) }
}

export async function enqueueRuntimeJob(
  name: string,
  data: unknown,
  cred: { userId: string; persona: AgentPersona; runId?: string },
): Promise<EnqueueResult> {
  const base = env.AGENT_RUNTIME_URL
  const secret = env.AGENT_RUNTIME_SECRET
  if (!base || !secret) return { ok: false, jobId: null, reason: 'not_configured' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const credential = signRuntimeCredential(secret, { userId: cred.userId, persona: cred.persona, runId: cred.runId ?? NIL_UUID })
    const res = await fetch(`${base.replace(/\/$/, '')}/internal/jobs/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `AMC-Runtime ${credential}` },
      body: JSON.stringify(data ?? {}),
      signal: ctrl.signal,
      cache: 'no-store',
    })
    const body = (await res.json().catch(() => null)) as { jobId?: string | null; deduped?: boolean; error?: string } | null
    if (!res.ok) {
      console.error(`[runtime-client] enqueue ${name} -> ${res.status}${body?.error ? ` (${body.error})` : ''}`)
      return { ok: false, jobId: null, reason: body?.error ? `http_${res.status}:${body.error.slice(0, 80)}` : `http_${res.status}` }
    }
    return { ok: true, jobId: body?.jobId ?? null, ...(body?.deduped === true ? { deduped: true } : {}) }
  } catch (e) {
    console.error(`[runtime-client] enqueue ${name} failed`, (e as Error).message)
    return { ok: false, jobId: null, reason: (e as Error).name || 'error' }
  } finally {
    clearTimeout(timer)
  }
}
