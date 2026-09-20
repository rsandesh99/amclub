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

export interface EnqueueResult {
  ok: boolean
  jobId: string | null
  /** Why it did not enqueue (not_configured | http_<status> | <error name>). */
  reason?: string
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
    const body = (await res.json().catch(() => null)) as { jobId?: string | null } | null
    if (!res.ok) {
      console.error(`[runtime-client] enqueue ${name} -> ${res.status}`)
      return { ok: false, jobId: null, reason: `http_${res.status}` }
    }
    return { ok: true, jobId: body?.jobId ?? null }
  } catch (e) {
    console.error(`[runtime-client] enqueue ${name} failed`, (e as Error).message)
    return { ok: false, jobId: null, reason: (e as Error).name || 'error' }
  } finally {
    clearTimeout(timer)
  }
}
