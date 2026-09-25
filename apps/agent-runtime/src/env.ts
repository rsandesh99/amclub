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
 * AGENT_MAX_TOKENS_<TIER> (output caps).
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
} as const

export function missingRuntimeConfig(): string[] {
  const missing: string[] = []
  if (!RUNTIME_ENV.RUNTIME_SECRET) missing.push('AGENT_RUNTIME_SECRET')
  if (!RUNTIME_ENV.SUPABASE_URL) missing.push('NEXT_PUBLIC_SUPABASE_URL')
  if (!RUNTIME_ENV.SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  return missing
}
