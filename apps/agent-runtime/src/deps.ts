import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Redis } from '@upstash/redis'
import {
  createGateway,
  createNoopBudget,
  createRedisBudget,
  createSupabaseLedger,
  createWhatsAppProvider,
  signRuntimeCredential,
  whatsappConfigFromEnv,
  type Budget,
  type Gateway,
  type RunAgentDeps,
  type RunContext,
} from '@amclub/agent-core'
import type { AgentPersona } from '@amclub/shared'
import { RUNTIME_ENV } from './env'
import { budgetCapsFor, onboardingSessionTtlHours } from './settings'
import { captureRuntimeEvent } from './analytics'
import type { OnboardingRuntimeDeps } from './agents/onboarding/index'
import type { MunshiRuntimeDeps } from './agents/munshi/index'
import type { SupportRuntimeDeps } from './agents/support/index'

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

/**
 * Caps are read from agent_settings once per run (lazy, on the first check) so
 * the founder's /admin/agents edits apply to the next run — including the
 * S1.6 per-agent run cap (budget_run_paise_by_agent[agentName]).
 */
function makeBudget(runId: string, userId: string, agentName?: string): Budget {
  const r = redis()
  if (!r) return createNoopBudget()
  return createRedisBudget({ redis: r, caps: () => budgetCapsFor(admin(), agentName), runId, userId })
}

/** Exchange the runtime HMAC for a run-bound delegated JWT via the web endpoint. */
export async function mintRuntimeToken(args: { runId: string; persona: AgentPersona; userId: string }): Promise<string> {
  const cred = signRuntimeCredential(RUNTIME_ENV.RUNTIME_SECRET, args)
  const res = await fetch(`${RUNTIME_ENV.API_URL}/api/v1/agent/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `AMC-Runtime ${cred}` },
    body: '{}',
  })
  // S1.4 guard: the web flag is off (404) or the user has no active grant for
  // this persona (403) are TERMINAL for a run — the worker never retries them.
  if (res.status === 404) throw new Error('agent_disabled')
  if (res.status === 403) throw new Error(`no_${args.persona}_grant`)
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`)
  const json = (await res.json()) as { token: string }
  return json.token
}

export function buildDeps(): RunAgentDeps {
  return {
    ledger: createSupabaseLedger(admin()),
    gateway: gateway(),
    makeBudget: ({ runId, userId, agentName }) => makeBudget(runId, userId, agentName),
    apiBaseUrl: RUNTIME_ENV.API_URL,
    makeToken: (args) => mintRuntimeToken(args),
  }
}

/** A RunContext for resuming an already-open run (the decision callback path). */
/** S1.6 — everything an onboarding turn needs; the worker builds it per job (the rig builds its own). */
export async function buildOnboardingDeps(): Promise<OnboardingRuntimeDeps> {
  return {
    core: buildDeps(),
    admin: admin(),
    whatsapp: createWhatsAppProvider(whatsappConfigFromEnv()),
    apiUrl: RUNTIME_ENV.API_URL,
    agentEnabled: RUNTIME_ENV.AGENT_ENABLED,
    tokenFor: ({ runId, userId }) => mintRuntimeToken({ runId, persona: 'provider', userId }),
    mediaBucket: RUNTIME_ENV.WA_MEDIA_BUCKET,
    ttlHours: await onboardingSessionTtlHours(admin()),
    capture: captureRuntimeEvent,
  }
}

/** S2.2 — everything the Munshi jobs need; keyless producers are the module defaults (honest by construction). */
export function buildMunshiDeps(): MunshiRuntimeDeps {
  return {
    core: buildDeps(),
    admin: admin(),
    whatsapp: createWhatsAppProvider(whatsappConfigFromEnv()),
    apiUrl: RUNTIME_ENV.API_URL,
    agentEnabled: RUNTIME_ENV.AGENT_ENABLED,
    tokenFor: ({ runId, userId }) => mintRuntimeToken({ runId, persona: 'provider', userId }),
    mediaBucket: RUNTIME_ENV.WA_MEDIA_BUCKET,
    runtimeSecret: RUNTIME_ENV.RUNTIME_SECRET,
    capture: captureRuntimeEvent,
  }
}

/** S2.3 — everything the Support jobs need; the keyless classifier is the module default (stubSupportIntent). */
export function buildSupportDeps(): SupportRuntimeDeps {
  return {
    core: buildDeps(),
    admin: admin(),
    whatsapp: createWhatsAppProvider(whatsappConfigFromEnv()),
    apiUrl: RUNTIME_ENV.API_URL,
    agentEnabled: RUNTIME_ENV.AGENT_ENABLED,
    tokenFor: ({ runId, userId }) => mintRuntimeToken({ runId, persona: 'buyer', userId }),
    mediaBucket: RUNTIME_ENV.WA_MEDIA_BUCKET,
    runtimeSecret: RUNTIME_ENV.RUNTIME_SECRET,
    capture: captureRuntimeEvent,
  }
}

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
