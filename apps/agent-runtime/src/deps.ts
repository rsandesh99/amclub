import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Redis } from '@upstash/redis'
import {
  createGateway,
  createNoopBudget,
  createRedisBudget,
  createSupabaseLedger,
  resolveCaps,
  signRuntimeCredential,
  type Budget,
  type Gateway,
  type RunAgentDeps,
  type RunContext,
} from '@amclub/agent-core'
import type { AgentPersona } from '@amclub/shared'
import { RUNTIME_ENV } from './env'

/**
 * Wires agent-core to the runtime's environment. The runtime NEVER uses the
 * service role for user data — it mints a delegated token by calling the web
 * token endpoint with its HMAC credential (ADR-008 §2). The service-role client
 * here backs the Ledger (agent_runs/events/invocations/decisions) only.
 */

let _admin: SupabaseClient | null = null
/** Service-role client — agent-owned telemetry + WhatsApp store ONLY (never user data reads). */
export function admin(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(RUNTIME_ENV.SUPABASE_URL, RUNTIME_ENV.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return _admin
}

let _gateway: Gateway | null = null
function gateway(): Gateway {
  if (!_gateway) _gateway = createGateway()
  return _gateway
}

let _redis: Redis | null = null
function redis(): Redis | null {
  if (_redis) return _redis
  const url = process.env['UPSTASH_REDIS_REST_URL']
  const token = process.env['UPSTASH_REDIS_REST_TOKEN']
  if (!url || !token) return null
  _redis = new Redis({ url, token })
  return _redis
}

function makeBudget(runId: string, userId: string): Budget {
  const r = redis()
  if (!r) return createNoopBudget()
  return createRedisBudget({ redis: r, caps: resolveCaps(), runId, userId })
}

/** Exchange the runtime HMAC for a run-bound delegated JWT via the web endpoint. */
export async function mintRuntimeToken(args: { runId: string; persona: AgentPersona; userId: string }): Promise<string> {
  const cred = signRuntimeCredential(RUNTIME_ENV.RUNTIME_SECRET, args)
  const res = await fetch(`${RUNTIME_ENV.API_URL}/api/v1/agent/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `AMC-Runtime ${cred}` },
    body: '{}',
  })
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`)
  const json = (await res.json()) as { token: string }
  return json.token
}

export function buildDeps(): RunAgentDeps {
  return {
    ledger: createSupabaseLedger(admin()),
    gateway: gateway(),
    makeBudget: ({ runId, userId }) => makeBudget(runId, userId),
    apiBaseUrl: RUNTIME_ENV.API_URL,
    makeToken: (args) => mintRuntimeToken(args),
  }
}

/** A RunContext for resuming an already-open run (the decision callback path). */
export function buildRunContext(args: { runId: string; userId: string; persona: AgentPersona }): RunContext {
  return {
    runId: args.runId,
    userId: args.userId,
    persona: args.persona,
    ledger: createSupabaseLedger(admin()),
    gateway: gateway(),
    budget: makeBudget(args.runId, args.userId),
    apiBaseUrl: RUNTIME_ENV.API_URL,
    getToken: () => mintRuntimeToken(args),
  }
}
