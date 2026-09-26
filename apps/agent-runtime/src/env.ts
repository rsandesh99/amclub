import { DEFAULT_WA_GRAPH_VERSION, WA_GRAPH_VERSION_RE } from '@amclub/agent-core'

/**
 * Runtime environment. Everything is optional so the process boots for a health
 * check even when unconfigured (dark build); real work needs the secrets set.
 * The runtime is a CLIENT of /api/v1 (API_URL) and holds the service role only
 * to write its OWN telemetry (SUPABASE_URL + SERVICE_ROLE_KEY).
 *
 * Read directly by agent-core (not listed here): UPSTASH_REDIS_REST_URL/TOKEN
 * (budget counters — without them model calls FAIL CLOSED when NODE_ENV is
 * production and AGENT_ENABLED=true), AGENT_LLM_BASE_URL[_<TIER>],
 * AGENT_RESIDENCY_ENFORCE + AGENT_IN_RESIDENCY_HOSTS or AGENT_RESIDENCY_WAIVER (the
 * residency guard — REQUIRED in production with AGENT_ENABLED=true, audit M23; /health
 * reports the posture), WA_MEDIA_MAX_BYTES / WA_MEDIA_TIMEOUT_MS (inbound media caps, M34),
 * AGENT_MODEL_RATES (cost estimate when the vendor reports none),
 * AGENT_MAX_TOKENS_<TIER> (output caps), and the WhatsApp driver (ADR-030: Meta's Cloud API
 * direct) — WHATSAPP_DRIVER (meta_cloud | stub), WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN,
 * WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, WHATSAPP_WABA_ID, WHATSAPP_GRAPH_VERSION (vNN.0,
 * default v24.0), WHATSAPP_TIMEOUT_MS (1000–60000, default 10000). A named driver with a missing
 * credential is logged at boot, reported by /health and refused by the webhook (503).
 */
export const RUNTIME_ENV = {
  /** The AMClub web app (API of record) the runtime calls back into. */
  API_URL: process.env['API_URL'] ?? process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000',
  /** HMAC secret shared with the web token endpoint + decision callback. */
  RUNTIME_SECRET: process.env['AGENT_RUNTIME_SECRET'] ?? '',
  /** Service-role Supabase for agent-owned telemetry ONLY (never user data). */
  SUPABASE_URL: process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '',
  SERVICE_ROLE_KEY: process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
  /** pg-boss job queue lives in the same Postgres. */
  DATABASE_URL: process.env['DATABASE_URL'] ?? '',
  PORT: Number(process.env['PORT'] ?? process.env['AGENT_RUNTIME_PORT'] ?? 8080),
  /** S0.5 — outbound WhatsApp replies from the inbound job are gated on this (webhook always stores). */
  AGENT_ENABLED: process.env['AGENT_ENABLED'] === 'true',
  WA_MEDIA_BUCKET: process.env['WA_MEDIA_BUCKET'] ?? 'wa-media',
  /** ADR-030 / audit B5 — the pinned Graph API version (validated `vNN.0`; an invalid value falls back and /health says so). */
  WHATSAPP_GRAPH_VERSION: WA_GRAPH_VERSION_RE.test(process.env['WHATSAPP_GRAPH_VERSION'] ?? '') ? (process.env['WHATSAPP_GRAPH_VERSION'] as string) : DEFAULT_WA_GRAPH_VERSION,
} as const

export function missingRuntimeConfig(): string[] {
  const missing: string[] = []
  if (!RUNTIME_ENV.RUNTIME_SECRET) missing.push('AGENT_RUNTIME_SECRET')
  if (!RUNTIME_ENV.SUPABASE_URL) missing.push('NEXT_PUBLIC_SUPABASE_URL')
  if (!RUNTIME_ENV.SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  return missing
}
