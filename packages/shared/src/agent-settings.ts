import { z } from 'zod'

/**
 * Agent config registry (ADR-009 §7, ARCHITECTURE.md §8). Every key the runtime
 * or a Vercel function reads from `agent_settings` is declared here with its Zod
 * shape and a launch default, so the admin editor (S0.2) validates exactly what
 * the code consumes and an unknown key can NEVER be written. Same closed-registry
 * pattern as `src/mart/settings.ts`.
 *
 * Readers: apps/web/lib/agent/settings.ts, packages/agent-core/src/budget,
 * the runner (agents_enabled + cohort), the token endpoint (consent version).
 */

/**
 * Every agent the programme will flip on, in build order (S1→S3). All ship dark:
 * the launch default for each is `false` (ARCHITECTURE.md §11). Adding an agent
 * here is additive — an absent key reads as false.
 */
export const AGENT_NAMES = [
  'payout_dossier', // S1.4
  'rfq_quality',    // S1.5
  'onboarding',     // S1.6
  'dispute_triage', // S1.7
  'munshi',         // S2.2
  'support',        // S2.3
  'procurement',    // S3.1
  'benchmark',      // S3.2
] as const
export type AgentName = (typeof AGENT_NAMES)[number]

/** agents_enabled value — a boolean per agent, every one defaulting to false. */
export const agentsEnabledSchema = z.object(
  Object.fromEntries(AGENT_NAMES.map((n) => [n, z.boolean().default(false)])) as Record<
    AgentName,
    z.ZodDefault<z.ZodBoolean>
  >,
)
export type AgentsEnabled = z.infer<typeof agentsEnabledSchema>

const AGENTS_ENABLED_DEFAULT: AgentsEnabled = Object.fromEntries(
  AGENT_NAMES.map((n) => [n, false]),
) as AgentsEnabled

export interface AgentSettingDef {
  schema: z.ZodTypeAny
  /** The launch value when the key is unset in the DB. */
  default: unknown
  /** What the key governs, for the admin editor + reviewers. */
  hint: string
}

export const AGENT_SETTING_DEFS = {
  agents_enabled: {
    schema: agentsEnabledSchema,
    default: AGENTS_ENABLED_DEFAULT,
    hint: 'Per-agent master switch. Every agent ships dark (false); the founder flips one per cohort from /admin/agents. The kill switch sets all false.',
  },
  budget_run_paise: {
    schema: z.number().int().min(0).max(1_000_000),
    default: 2000,
    hint: 'Max estimated AI spend (paise) for a single agent run before it fails cleanly. ₹20 at launch.',
  },
  budget_user_day_paise: {
    schema: z.number().int().min(0).max(10_000_000),
    default: 5000,
    hint: 'Max estimated AI spend (paise) per user per day across all runs. ₹50 at launch.',
  },
  budget_month_paise: {
    schema: z.number().int().min(0).max(1_000_000_000),
    default: 500_000,
    hint: 'Max estimated AI spend (paise) per calendar month, platform-wide. ₹5,000 at launch.',
  },
  cohort_user_ids: {
    schema: z.array(z.string().uuid()).max(500),
    default: [] as string[],
    hint: 'Allowlist of user ids an enabled agent runs for. Empty = no one (dark) even when agents_enabled.<name> is true.',
  },
  whatsapp_opt_in_text_version: {
    schema: z.string().min(1).max(40),
    default: 'v1',
    hint: 'Version tag of the WhatsApp consent text captured in agent_grants.consent (S0.5). Bump when the wording changes.',
  },
  // ── S0.4 trust mechanics ─────────────────────────────────────────────────
  rfq_max_quotes: {
    // null = unset => the route falls back to the legacy 7 (effectiveQuoteCap),
    // so deploying this key changes nothing until the founder sets it.
    schema: z.number().int().min(3).max(7).nullable(),
    default: null,
    hint: "S0.4 quote cap applied to NEW RFQs (3..7). Unset = 7 (the historical hard-coded cap), so existing behaviour holds until the founder sets it.",
  },
  quote_window_hours: {
    // null = sweep OFF (ships dark; founder sets e.g. 48 in /admin/agents).
    schema: z.number().int().min(6).max(168).nullable(),
    default: null,
    hint: "S0.4 quote-or-decline window (hours). null = the rfq-expire sweep is OFF. When set, matches older than this with no quote and no decline are auto-declined (window_lapsed) and the buyer is told.",
  },
  evidence_required_from: {
    schema: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').nullable(),
    default: null,
    hint: 'S0.3 cutover (ISO date). Services orders placed on/after this date are payout-held until a work-complete photo + buyer confirmation exist. null = not enforced (the milestone capture UI still works).',
  },
} as const satisfies Record<string, AgentSettingDef>

export type AgentSettingKey = keyof typeof AGENT_SETTING_DEFS
export const AGENT_SETTING_KEYS = Object.keys(AGENT_SETTING_DEFS) as AgentSettingKey[]

/** The launch default for a key (used when the DB has no row). */
export function agentSettingDefault<K extends AgentSettingKey>(key: K): unknown {
  return AGENT_SETTING_DEFS[key].default
}

/** Validate a value for a known key. Unknown keys never parse (closed registry). */
export function parseAgentSetting(
  key: string,
  value: unknown,
): { ok: true; key: AgentSettingKey; value: unknown } | { ok: false; error: string } {
  const def = (AGENT_SETTING_DEFS as Record<string, AgentSettingDef>)[key]
  if (!def) return { ok: false, error: `unknown_key:${key}` }
  const r = def.schema.safeParse(value)
  if (!r.success) {
    return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || key}: ${i.message}`).join('; ') }
  }
  return { ok: true, key: key as AgentSettingKey, value: r.data }
}

/** PUT /api/v1/agent/admin/settings body — value checked per key by parseAgentSetting. */
export const agentSettingPutSchema = z.object({
  key: z.enum(AGENT_SETTING_KEYS as [AgentSettingKey, ...AgentSettingKey[]]),
  value: z.unknown(),
})
export type AgentSettingPutInput = z.infer<typeof agentSettingPutSchema>

/** All agents_enabled flags set false — the kill switch payload (S0.2). */
export function killSwitchAgentsEnabled(): AgentsEnabled {
  return { ...AGENTS_ENABLED_DEFAULT }
}
