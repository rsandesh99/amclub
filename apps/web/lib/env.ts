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
})

const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  DATABASE_URL: z.string().url().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  MSG91_AUTH_KEY: z.string().optional(),
  WHATSAPP_API_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  KYC_API_KEY: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  SENTRY_AUTH_TOKEN: z.string().optional(),
  // Upstash Redis REST — backs rate limiting. When unset, the limiter is a
  // no-op (allow all) so local/dev keeps working without Redis.
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
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
