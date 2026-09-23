import { z } from 'zod'

/**
 * Zod-validated environment variables. §2.4 / §2.5 rule 5.
 * Server-only vars are never prefixed NEXT_PUBLIC_.
 * Import this only in server-side code — do NOT use in client components
 * (server-only vars will be undefined there anyway, but importing this file
 * in a client bundle would expose the schema and cause build issues).
 */

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('NEXT_PUBLIC_SUPABASE_URL must be a valid URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, 'NEXT_PUBLIC_SUPABASE_ANON_KEY is required'),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z
    .string()
    .url()
    .default('https://eu.posthog.com'),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  NEXT_PUBLIC_RAZORPAY_KEY_ID: z.string().optional(),
  // Cloudflare Turnstile site key (public). The matching SECRET key lives in the
  // Supabase dashboard (Auth → Settings → CAPTCHA), not here. When unset, the
  // captcha widget is skipped (dev/local).
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().optional(),
  // S0.5 — the business WhatsApp number users message (E.164 digits) for the wa.me deep link.
  NEXT_PUBLIC_WHATSAPP_NUMBER: z.string().optional(),
})

const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  DATABASE_URL: z.string().url().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  MSG91_AUTH_KEY: z.string().optional(),
  WHATSAPP_API_KEY: z.string().optional(),
  // S0.5 WhatsApp rails. Driver is stub (no bill) unless WHATSAPP_DRIVER + creds are set.
  WHATSAPP_DRIVER: z.enum(['meta_cloud', 'interakt', 'stub']).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  INTERAKT_API_KEY: z.string().optional(),
  INTERAKT_WEBHOOK_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  KYC_API_KEY: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  SENTRY_AUTH_TOKEN: z.string().optional(),
  // Upstash Redis REST — backs rate limiting AND the agent budget counters. When
  // unset, the limiter is a no-op (allow all) so local/dev keeps working without
  // Redis; agent model calls FAIL CLOSED instead when NODE_ENV/VERCEL_ENV is
  // production and AGENT_ENABLED=true (budget breach 'store_unavailable').
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  // Voice RFQ (Phase 8b). Both vendors stub (log "would …", no paid call)
  // when their key is unset. Model id is OpenRouter's namespace.
  SARVAM_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  VOICE_PARSE_MODEL: z.string().optional(),
  // ai_invocations cost estimates (v1.1). Unset → cost_est_paise stays null
  // for STT; OpenRouter conversion falls back to ₹88/USD.
  SARVAM_COST_PAISE_PER_MIN: z.string().optional(),
  OPENROUTER_USD_INR_PAISE: z.string().optional(),
  // Task-class model router (H0, ADR-008). Tier -> OpenAI-compatible model id;
  // unset -> agent-core router defaults (routine default == Phase 8b parser).
  AGENT_MODEL_LIVE: z.string().optional(),
  AGENT_MODEL_ROUTINE: z.string().optional(),
  AGENT_MODEL_REASONING: z.string().optional(),
  AGENT_MODEL_FRONTIER: z.string().optional(),
  // Agent programme S0.1 (ADR-009). All optional in the dark build — the token
  // endpoint 404s while AGENT_ENABLED=false and the gateway stubs without a key.
  // Delegated identity: mint the run-bound JWT with the project's JWT secret.
  SUPABASE_JWT_SECRET: z.string().optional(),
  // The always-on runtime (Fly bom): its base URL + the HMAC the token endpoint
  // trusts and the decision route calls back with.
  AGENT_RUNTIME_URL: z.string().url().optional(),
  AGENT_RUNTIME_SECRET: z.string().optional(),
  // LLM gateway (OpenAI-compatible). Absent key -> stub mode (no bill).
  AGENT_LLM_BASE_URL: z.string().url().optional(),
  AGENT_LLM_API_KEY: z.string().optional(),
  AGENT_EMBED_BASE_URL: z.string().url().optional(),
  AGENT_MODEL_EMBEDDING: z.string().optional(),
  // Track F — per-tier chat base URL overrides (fallback AGENT_LLM_BASE_URL), so an
  // in-India endpoint can serve one tier without moving the others.
  AGENT_LLM_BASE_URL_LIVE: z.string().url().optional(),
  AGENT_LLM_BASE_URL_ROUTINE: z.string().url().optional(),
  AGENT_LLM_BASE_URL_REASONING: z.string().url().optional(),
  AGENT_LLM_BASE_URL_FRONTIER: z.string().url().optional(),
  // Data-residency guard (OPT-IN; default off = today's behaviour). When 'true' the
  // gateway refuses an 'in' task class (TASK_CLASS_RESIDENCY) to any host not in
  // AGENT_IN_RESIDENCY_HOSTS (comma-separated hostnames).
  AGENT_RESIDENCY_ENFORCE: z.enum(['true', 'false']).optional(),
  AGENT_IN_RESIDENCY_HOSTS: z.string().optional(),
  // Cost estimation when the vendor reports no cost: JSON
  // {"<model id>": {"inPerMTokUsd": n, "outPerMTokUsd": n}}. Missing model -> a
  // conservative fallback rate (never ₹0 for a live call).
  AGENT_MODEL_RATES: z.string().optional(),
  // Output caps (max_tokens) per tier; unset -> gateway defaults (800/1200/4000/2500).
  AGENT_MAX_TOKENS_LIVE: z.string().optional(),
  AGENT_MAX_TOKENS_ROUTINE: z.string().optional(),
  AGENT_MAX_TOKENS_REASONING: z.string().optional(),
  AGENT_MAX_TOKENS_FRONTIER: z.string().optional(),
  // Budget cap overrides (else agent_settings, else registry defaults).
  AGENT_BUDGET_RUN_PAISE: z.string().optional(),
  AGENT_BUDGET_USER_DAY_PAISE: z.string().optional(),
  AGENT_BUDGET_MONTH_PAISE: z.string().optional(),
  // AGENT_ENABLED gates every /api/v1/agent/* surface (dark build). Default OFF.
  AGENT_ENABLED: z.string().optional(),
  // Feature flags. 'true' enables; anything else (incl. unset) = OFF.
  // COUPONS_ENABLED gates the entire Phase-6 coupon path (see lib/flags.ts).
  COUPONS_ENABLED: z.string().optional(),
  // Experience v3 rollout flags (PRD §7.9; registry in @amclub/shared
  // experiments.ts): 'off' (default) | 'on' | a 0–100 percentage.
  EXP_V3_SHELL: z.string().optional(),
  EXP_V3_SEARCH: z.string().optional(),
  EXP_V3_TRUST: z.string().optional(),
  EXP_V3_PACKAGES: z.string().optional(),
  EXP_V3_CHECKOUT: z.string().optional(),
  EXP_V3_REQUIREMENTS: z.string().optional(),
  EXP_V3_COMPARE: z.string().optional(),
  EXP_V3_ORDERS: z.string().optional(),
  EXP_V3_HOME: z.string().optional(),
  EXP_V3_ONBOARDING: z.string().optional(),
  EXP_V3_PARTNER: z.string().optional(),
  EXP_V3_MOBILE: z.string().optional(),
  EXP_V3_LOCALES: z.string().optional(),
  EXP_V3_LOCALES_NAMESPACES: z.string().optional(),
  // Comma-separated user ids who see every Experience v3 flag (internal testing on prod).
  EXP_V3_COHORT: z.string().optional(),
})

function parseEnv() {
  const publicResult = publicEnvSchema.safeParse(process.env)
  const serverResult = serverEnvSchema.safeParse(process.env)

  const errors: string[] = []

  if (!publicResult.success) {
    errors.push(...publicResult.error.issues.map((i) => `[public] ${i.path.join('.')}: ${i.message}`))
  }
  if (!serverResult.success) {
    errors.push(...serverResult.error.issues.map((i) => `[server] ${i.path.join('.')}: ${i.message}`))
  }

  if (errors.length > 0) {
    throw new Error(
      `❌ Invalid environment variables:\n${errors.map((e) => `  • ${e}`).join('\n')}\n\nSee .env.example for required variables.`,
    )
  }

  return {
    ...publicResult.data!,
    ...serverResult.data!,
  }
}

export const env = parseEnv()
