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
  'quote_extract',  // S1.1
  'compare_pointers', // S1.2
  'decline_message',  // S1.2
  'payout_dossier', // S1.4
  'rfq_quality',    // S1.5
  'rfq_clarify',    // S1.8 — the one clarifying question after an uncertain voice parse
  'document_intake', // S1.8 — photo / PDF / drawing → prefill
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
  // ── S2.4 AMC Score v1 (ADR-010) — every switch defaults OFF; the formula is code, never a setting ──
  score_compute_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'S2.4 nightly cron/score-compute writes provider + buyer AMC Score snapshots, history and events. Off = the cron is a no-op heartbeat. Run it for two weeks and review the distribution before turning the card on.',
  },
  score_card_enabled: {
    schema: z.boolean(),
    default: false,
    hint: "S2.4 providers see their OWN score (components, tips, trend) on the partner dashboard and GET /partner/score. Buyers never see a number; this switch does not change that.",
  },
  reliability_rank_enabled: {
    schema: z.boolean(),
    default: false,
    hint: "S2.4 the compare screen orders quotes by price adjusted for reliability above the threshold (server-side; the buyer sees an order and one line, never a score). Keep OFF until the founder confirms ADR-010 §9 (e): ordering is not 'showing' the score.",
  },
  reliability_rank_threshold_paise: {
    schema: z.number().int().min(0),
    default: 2_500_000,
    hint: 'S2.4 reliability ordering applies only when the largest quote total reaches this (paise). 2 500 000 = ₹25,000.',
  },
  reliability_rank_k_bps: {
    schema: z.number().int().min(0).max(5000),
    default: 1500,
    hint: 'S2.4 the ordering penalty in basis points of price at a score of 0, scaling linearly with the shortfall from 100 (1500: score 90 → +1.5 %, 60 → +6 %, 40 → +9 %). Used only to ORDER; prices shown are unchanged.',
  },
  score_null_prior: {
    schema: z.number().int().min(0).max(100),
    default: 60,
    hint: 'S2.4 what a provider below the sample gate (no score yet) ranks as — neutral, neither buried nor boosted.',
  },
  growth_nudge_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'S2.4 Munshi providers get at most one informational growth nudge a week (fixed copy; WhatsApp + in-app). Also needs agents_enabled.munshi + cohort + the provider’s grant.',
  },
  // ── S2.3 Support agent ───────────────────────────────────────────────────
  support_escalate_after_turns: {
    schema: z.number().int().min(1).max(5),
    default: 2,
    hint: 'S2.3 how many consecutive unclear turns open a support ticket (the agent then goes quiet on that conversation until a human resolves it).',
  },
  support_nudge_cooldown_hours: {
    schema: z.number().int().min(1).max(168),
    default: 24,
    hint: 'S2.3 the counterparty nudge cap: at most one nudge per sender per subject (order / RFQ) in this many hours.',
  },
  support_ops_quiet_hours: {
    schema: z.object({ from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).strict().nullable(),
    default: null,
    hint: 'S2.3 IST window (HH:MM–HH:MM) during which ticket WhatsApp pings to the ops user are held; in-app is immediate. null = no quiet hours.',
  },
  // ── S2.2 Digital Munshi ──────────────────────────────────────────────────
  munshi_price_tolerance_bps: {
    schema: z.number().int().min(0).max(10_000),
    default: 2500,
    hint: 'S2.2 how far (basis points) a Munshi draft price may sit outside the [min, max] of the basis price-book rows. 2500 = 25 %. A price outside the band becomes a question, never an adjusted number.',
  },
  munshi_max_drafts_per_day: {
    schema: z.number().int().min(1).max(100),
    default: 20,
    hint: 'S2.2 max Munshi drafts per provider per day (IST date). The scan stops drafting at the cap; the rest wait for tomorrow.',
  },
  munshi_followup_hours_before_lapse: {
    schema: z.number().int().min(1).max(24),
    default: 6,
    hint: 'S2.2 Munshi warns a provider once per match when the quote-or-decline window (quote_window_hours) lapses within this many hours. No-op while quote_window_hours is null.',
  },
  // ── S1.4 payout dossier ─────────────────────────────────────────────────
  ops_user_id: {
    // null = no ops identity => the dossier trigger is a no-op even when the
    // agent flag is on (ships dark). Must hold the admin role + an active ops grant.
    schema: z.string().uuid().nullable(),
    default: null,
    hint: 'S1.4 the founder/ops user the ops persona runs on behalf of (payout dossiers). Must hold the admin role and an active ops grant (persona ops, channel web). null = the Payout-Evidence agent never runs.',
  },
  dossier_max_photos: {
    schema: z.number().int().min(1).max(12),
    default: 6,
    hint: 'S1.4 max evidence photos per dossier sent to the vision tier (latest per milestone kind first). Caps model cost per dossier.',
  },
  dossier_dup_hamming_max: {
    schema: z.number().int().min(0).max(20),
    default: 6,
    hint: 'S1.4 dHash Hamming distance at/below which two evidence photos count as duplicates (same provider, different order => anomaly). 0 = exact only.',
  },
  evidence_required_from: {
    schema: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').nullable(),
    default: null,
    hint: 'S0.3 cutover (ISO date). Services orders placed on/after this date are payout-held until a work-complete photo + buyer confirmation exist. null = not enforced (the milestone capture UI still works).',
  },
  rfq_quality_hold_minutes: {
    schema: z.number().int().min(5).max(180),
    default: 30,
    hint: "S1.5 minutes a deferred RFQ waits for the buyer's answers before the cron guard fans it out as is.",
  },
  // ── S1.6 onboarding ──────────────────────────────────────────────────────
  budget_run_paise_by_agent: {
    // Partial map agent → per-run cap; an absent agent uses budget_run_paise. Unknown agent names never parse.
    schema: z.record(z.enum(AGENT_NAMES), z.number().int().min(0).max(1_000_000)),
    default: {} as Partial<Record<AgentName, number>>,
    hint: 'S1.6 per-agent override of budget_run_paise (paise). Absent agent = the global cap. Onboarding launches at 1500 (₹15).',
  },
  onboarding_session_ttl_hours: {
    schema: z.number().int().min(1).max(168),
    default: 72,
    hint: 'S1.6 hours an unfinished WhatsApp onboarding session stays open (sliding on each answer) before the expiry job abandons it and points the provider to the web wizard.',
  },
  // ── S1.8 voice RFQ v2 ──────────────────────────────────────────────────────
  clarify_tts_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'S1.8 synthesise the clarifying question as audio (Sarvam TTS, paid). false = text only.',
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
