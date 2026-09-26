import { z } from 'zod'
import { VOICE_SEARCH_LANGUAGES, voiceLanguageEvalsSchema } from './voice-languages'

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
  'review_summary', // Experience v3 E3 (FR-3.9) — cited summary of verified reviews; dark slot, built when the agent programme resumes
  'content_translate', // Experience v3 E14 (FR-14.3, N32b) — provider content translation drafts; the provider approves each language
  'demand_aggregation', // S3.4 (ADR 024) — group requests for services: proposes pools (code, no model); buyers opt in, providers state volume tiers
] as const
export type AgentName = (typeof AGENT_NAMES)[number]

/**
 * Agents that only work through the agent runtime (pg-boss jobs on Fly) and
 * delegated run tokens. Without AGENT_RUNTIME_URL + AGENT_RUNTIME_SECRET +
 * SUPABASE_JWT_SECRET they cannot act: jobs are never queued and tokens can't
 * be minted. So they read as OFF, rather than showing a surface that silently
 * never answers (onboarding sends people to WhatsApp, Munshi "approves" drafts
 * that are never sent, the assistant only ever says "will reply shortly").
 * Support is not listed: its web chat is a bounded call on Vercel, and only
 * its WhatsApp side lives in the runtime.
 */
export const RUNTIME_AGENTS = ['payout_dossier', 'onboarding', 'dispute_triage', 'munshi', 'procurement'] as const satisfies readonly AgentName[]

/** False for a runtime agent while the runtime is not configured; every other agent is unaffected. */
export function agentRunnable(name: AgentName, runtimeReady: boolean): boolean {
  return runtimeReady || !(RUNTIME_AGENTS as readonly AgentName[]).includes(name)
}

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

// ── ADR-030 consent — the cohort rule (audit B8), read by the runtime and the web availability checks ──
export const COHORT_MODES = ['list', 'all'] as const
export type CohortMode = (typeof COHORT_MODES)[number]

/**
 * Is this user in the agents' cohort? `cohort_mode = 'all'` → everyone; otherwise (the default, and any unreadable value)
 * the `cohort_user_ids` allowlist. Callers still check the agent's own switch (agents_enabled) and the user's grant.
 */
export function inAgentCohort(mode: unknown, cohortUserIds: unknown, userId: string): boolean {
  if (mode === 'all') return true
  return Array.isArray(cohortUserIds) && cohortUserIds.includes(userId)
}

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
  budget_month_open_paise: {
    schema: z.number().int().min(0).max(1_000_000_000),
    default: 200_000,
    hint: 'Audit M24: the part of budget_month_paise that users OUTSIDE cohort_user_ids may spend per month on the open paid endpoints (voice parser, speech-to-text, Mart catalog drafts), on its own counter. The rest is held for the cohort and ops. ₹2,000 at launch; never more than the month cap.',
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
  // ── S3.1 Buyer Procurement Agent (built dark; enablement is the V1.5 → V2 gate + a §8.1 mini-PRD) ──
  procurement_chase_hours: {
    schema: z.number().int().min(1).max(168),
    default: 24,
    hint: 'S3.1 hours after fan-out with ZERO quotes before the procurement agent tells the buyer and offers one nudge to the matched providers (the S2.3 nudge cap still applies).',
  },
  procurement_session_ttl_days: {
    schema: z.number().int().min(1).max(30),
    default: 7,
    hint: 'S3.1 days a procurement session stays open without activity (sliding on each buyer turn) before the watcher closes it with a final message.',
  },
  procurement_max_proposals_per_day: {
    schema: z.number().int().min(1).max(200),
    default: 30,
    hint: 'S3.1 max proposals (create / answer / message / choose / decline / nudge cards) the procurement agent may put to ONE buyer per IST day; past it the agent points the buyer to the app.',
  },
  // ── Experience v3 E3 — trust made visible (PRD_EXPERIENCE_V3 §6 E3; D1 + ADR-010 amendment) ──
  public_stats_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'E3 / D1: buyers see a provider\'s INDIVIDUAL measured stats (on-time %, repeat-buyer %, response rate, each with its sample) on cards and the profile. Never the composite AMC Score. Off until the founder decides D1 and ADR-010 is amended.',
  },
  public_stats_min_n: {
    schema: z.number().int().min(5).max(500),
    default: 10,
    hint: 'E3 sample gate: a stat shows only when its own sample is at least this many (floor 5 in code).',
  },
  gstin_recheck_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'E3 / F4: the nightly job re-checks every active provider\'s GSTIN with the KYC vendor (paid calls) and flags cancelled or suspended ones to ops. It never suspends anyone by itself.',
  },
  // ── Experience v3 E2b — voice search (PRD_EXPERIENCE_V3 FR-2.5, N5) ──
  voice_search_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'E2b / N5: the mic in the catalog search field (speech → an English query + the detected language, the Phase 8b pipeline in mode=query). Paid STT + one parse per use; signed-in buyers only. Turn on only after the 30-query eval (te/hi/en, code-mixed) finds the right category ≥ 85 %.',
  },
  // ── Experience v3 E14 — voice search, one language at a time (FR-14.5) ──
  voice_search_languages: {
    schema: z.array(z.enum(VOICE_SEARCH_LANGUAGES)).max(VOICE_SEARCH_LANGUAGES.length),
    default: ['en', 'hi', 'te'],
    hint: 'E14 / FR-14.5: the languages the catalog mic may answer in. A listed language still stays off until its recorded eval passes (voice_language_evals: ≥ 50 queries, WER ≤ 20 %, right category ≥ 85 %); an unlisted or failing language gets "type instead".',
  },
  voice_language_evals: {
    schema: voiceLanguageEvalsSchema,
    default: {},
    hint: 'E14 / FR-14.5: the last eval per language, written by `pnpm --filter @amclub/web voice:eval -- --lang <code> --set <file> --record`. Edit only to clear a result; a hand-typed pass does not count unless it carries the current eval version.',
  },
  // ── Experience v3 E15 — shadow predictions (FR-15.5, F10): each writer has its own switch; nobody but the admin console sees them ──
  shadow_cad_price_band_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'E15 / F10: at fan-out, log a rules-v1 price band for an RFQ with a CAD drawing; resolved against the winning quote on acceptance. Shadow only — shown to nobody; the weekly error is at /admin/shadow.',
  },
  shadow_provider_fit_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'E15 / F10: at fan-out, log a rules-v1 fit % per matched provider; resolved at acceptance (quoted / won). Shadow only — never ranks, filters or shows anything.',
  },
  // ── Experience v3 E15 — search telemetry sample (FR-15.3, F5) ──
  search_telemetry_sample_pct: {
    schema: z.number().int().min(0).max(100),
    default: 20,
    hint: 'E15 / F5: the share of search result pages recorded in search_queries (normalised parameters + result count; no user id; kept 180 days). 0 = off. Attribution (search → order) rides every search regardless.',
  },
  // ── Experience v3 E15 — consented corpora opt-in (FR-15.4, F6) ──
  corpus_consent_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'E15 / F6: show the buyer profile opt-in "Help improve AMClub\'s Hindi and Telugu understanding" and keep text-only voice triples / image pairs for buyers who opt in. Off: the toggle is hidden, opting in 404s and nothing new is kept; revoking (which deletes the rows) always works. Apply migration 0063 first.',
  },
  // ── Experience v3 E6 — document suggestions on the requirement form (FR-6.3) ──
  document_suggestions_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'E6 / N19: "Documents you\'ll likely need" on the requirement form. Only rows a CA / lawyer has stamped (service_document_requirements.reviewed_at) are ever shown; keep off until the content review is done.',
  },
  // ── Experience v3 E9b — licences, renewal reminders, "What do I need?" (FR-9.5, N45; gated by D-PRD5) ──
  obligations_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'E9b / N45 (D-PRD5): the buyer\'s licences, renewal reminders (60 / 30 / 7 days, once each) and the obligations checklist. Keep off until counsel and the CA answer D-PRD5 and the checklist reaches >= 95 % precision on the CA\'s 50-profile set; only CA-reviewed obligation_rules are ever shown.',
  },
  // ── Experience v3 E11 — "Buyer verified ✓" in the provider inbox (FR-11.3, N28b; gated by D2) ──
  buyer_verified_badge_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'E11 / N28b (D2): the inbox shows "Buyer verified ✓" (a boolean only — Udyam or GSTIN verified AND at least one paid order on AMClub). No buyer id, name, count or contact before a quote; fan-out and the 7-quote cap are unchanged. Turn on only after D2.',
  },
  // ── Experience v3 E11c — tender alerts + the GeM seller checklist (FR-11.6, N30; gated by D9 + its mini-PRD) ──
  tenders_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'E11c / N30 (D9): /partner/tenders — tender ALERTS matched by category + state for verified government-licensing providers (Save / Not relevant; the official portal link) and the reviewed GeM checklist. No bidding, applying or submitting inside AMClub. Turn on only after D9 and the mini-PRD settle the data source and its licence.',
  },
  // ── Experience v3 E12c — compliance bundles with milestone escrow (ADR 021; money) ──
  bundles_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'E12c / ADR 021: a package with 2–6 milestones (≤ 92 days, shares summing to 100 %) sells as ONE payment that becomes one ordinary child order per milestone; unstarted children refund in full ("Cancel remaining" on /app/plans). Off: the milestone editor, the plan display and /app/plans are hidden and checkout sells the package as a single order. Apply migration 0067 first; counsel + Razorpay must clear holding buyer money for the plan length.',
  },
  // ── Experience v3 E12b — quote speed options (ADR 020; money) ──
  quote_options_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'E12b / ADR 020: a provider may offer Economy (slower, never dearer) and Express (faster, never cheaper) beside the quoted Standard price; the buyer picks one on compare and checkout charges that option (ADR-015 per option). Off: the quote form hides it, options are refused (422) and checkout refuses an optionId (409). Apply migration 0066 first.',
  },
  // ── Experience v3 E12a — package add-ons (ADR 019; money) ──
  addons_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'E12a / ADR 019: providers add up to 3 priced extras per package ("+₹500 · 1 day faster"); buyers pick them in the buy box and checkout (one computeOrderAmounts on package + add-ons, frozen on the session, one invoice line each). Off: the editor and buy box show nothing and checkout refuses addonIds (409 addon_changed). Apply migration 0065 first.',
  },
  // ── Experience v3 E8b — messaging on a paid order (FR-8.4, N24); also needs the `orders` experience ──
  order_messaging_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'E8b / N24: the Messages tab on an order — buyer and provider write to each other after payment (phone / email masked exactly like quote threads; in-app + the WhatsApp template "New message on order #…" with no message text; read-only 30 days after completion or resolution). Also needs EXP_V3_ORDERS for the user. Apply migration 0059 and approve the order_message template first.',
  },
  // ── S3.2 fair price ranges (benchmarks) — compute and display are separate switches, both OFF; the formula is code ──
  benchmark_compute_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'S3.2 nightly cron/benchmark-compute writes price_benchmarks from PAID services jobs (last 180 days). Off = the cron is a no-op heartbeat. Run it and review the table for two weeks before turning display on.',
  },
  benchmark_display_enabled: {
    schema: z.boolean(),
    default: false,
    hint: 'S3.2 the buyer and every matched provider see the same "Similar jobs … closed at ₹X–₹Y" line on a services request (web + mobile). Nothing renders when no row passes the gates.',
  },
  benchmark_min_sample: {
    schema: z.number().int().min(30).max(1000),
    default: 30,
    hint: 'S3.2 privacy gate: a range exists only with at least this many paid jobs in the key. Can only be raised (floor 30 — the "How is this calculated?" copy and the table CHECK state it).',
  },
  benchmark_min_providers: {
    schema: z.number().int().min(8).max(200),
    default: 8,
    hint: 'S3.2 privacy gate: at least this many distinct providers in the key (no single provider can be read off the range).',
  },
  benchmark_min_buyers: {
    schema: z.number().int().min(8).max(200),
    default: 8,
    hint: 'S3.2 privacy gate: at least this many distinct buyers in the key (no single buyer’s spend can be read off the range).',
  },
  benchmark_max_provider_share_bps: {
    schema: z.number().int().min(500).max(2500),
    default: 2500,
    hint: 'S3.2 privacy gate: no single provider may contribute more than this share of the sample (basis points; 2500 = 25 %). Can only be tightened (ceiling 2500).',
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
  // ── ADR-014 (H2) dispute window ─────────────────────────────────────────
  dispute_window_days: {
    schema: z.number().int().min(1).max(90),
    default: 7,
    hint: 'ADR-014 H2 — days after a services order completes (completed_at) during which the buyer can still report a problem. Before completion a dispute is always possible. Goods orders use their Mart category return window instead.',
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
    hint: 'S1.6 per-agent override of budget_run_paise (paise). Absent agent = the global cap. Onboarding launches at 1500 (₹15); procurement (S3.1) is documented at 1500 (₹15) per turn run.',
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
  // ── S3.4 demand aggregation (ADR 024) ─────────────────────────────────────
  pool_min_members: {
    schema: z.number().int().min(2).max(20),
    default: 3,
    hint: 'S3.4 distinct buyers needed to propose a group, and joined buyers needed to open it to providers.',
  },
  pool_max_members: {
    schema: z.number().int().min(2).max(50),
    default: 20,
    hint: 'S3.4 most requests in one group; also the highest tier threshold a provider may set.',
  },
  pool_form_hours: {
    schema: z.number().int().min(1).max(48),
    default: 12,
    hint: 'S3.4 hours a proposed group waits for enough buyers to join before it lapses (their requests carry on as normal).',
  },
  pool_open_hours: {
    schema: z.number().int().min(6).max(72),
    default: 24,
    hint: 'S3.4 hours an open group takes provider offers and buyer choices before it closes (earlier if a member request would expire).',
  },
  pool_pay_buffer_hours: {
    schema: z.number().int().min(1).max(48),
    default: 12,
    hint: "S3.4 hours between a group's close and the earliest member request's expiry, so every group price can still be paid.",
  },
  // ── ADR-030 consent (WhatsApp: who the assistant serves, recycled numbers) ──
  cohort_mode: {
    schema: z.enum(COHORT_MODES),
    default: 'list' as CohortMode,
    hint: "Audit B8 / D-WA2: 'list' = an enabled agent runs only for cohort_user_ids (today's allowlist); 'all' = every user, still subject to each agent's own switch in agents_enabled and the user's own grant. The non-AI WhatsApp HELP menu serves everyone either way. Budgets: the open envelope (budget_month_open_paise) still follows the explicit list.",
  },
  wa_rebind_dormant_days: {
    schema: z.number().int().min(0).max(3650),
    default: 90,
    hint: 'ADR-030 recycled numbers: before WhatsApp acts for an account not signed in for this many days (users.last_seen_at, else its creation), it asks the person to sign in first ("confirm it is you") and does nothing else for that account. Telcos reissue numbers after about 90 days. 0 = off.',
  },
  // ── ADR-030 privacy ops (D-WA5 retention, DPDP requests) ─────────────────
  wa_retention_text_days: {
    schema: z.number().int().min(30).max(1825),
    default: 180,
    hint: 'ADR-030 §6 days after which the wa-retention cron redacts WhatsApp message text, transcripts and payloads (unless on legal hold, or the user has an open ticket, open dispute or an order not yet done).',
  },
  wa_retention_media_days: {
    schema: z.number().int().min(7).max(1825),
    default: 90,
    hint: 'ADR-030 §6 days after which WhatsApp media (voice notes, photos, documents in the wa-media bucket) are deleted, with the same holds as text.',
  },
  wa_retention_unknown_days: {
    schema: z.number().int().min(7).max(365),
    default: 30,
    hint: 'ADR-030 §6 days after which the conversation of a number that never bound to an AMClub account is deleted with its messages and media (consent events stay as proof).',
  },
  dpdp_due_days: {
    schema: z.number().int().min(1).max(90),
    default: 30,
    hint: 'ADR-030 §6 days within which a DPDP request (access, correction, erasure, withdrawal, grievance) is answered; the due date is set when the request is recorded and /admin/privacy flags overdue ones.',
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
