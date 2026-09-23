/**
 * S1.4 — applied-migration preflight (verify-* convention).
 *
 * For every migration file, asserts its principal objects exist in the target
 * database. The manifest below is HAND-CURATED by design — parsing SQL for
 * object names is false precision. Every new migration MUST add its manifest
 * entry (enforced: the script fails if a migration file has no entry).
 *
 * Two modes:
 *   REST mode (default, needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   from apps/web/.env.local): verifies tables and views by probing PostgREST
 *   with the service role — structure coverage, functions/triggers SKIPPED.
 *   SQL mode (additionally set DATABASE_URL): authoritative — to_regclass for
 *   tables/views, pg_proc for functions, pg_trigger for triggers.
 *
 * Exit: non-zero on ANY missing object (SKIPPED is not missing).
 * Run: pnpm --filter @amclub/web exec tsx scripts/verify-migrations.ts
 */
import { config } from 'dotenv'
import path from 'path'
import { readdirSync } from 'fs'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

interface Entry {
  file: string
  tables?: string[]
  views?: string[]
  functions?: string[]
  /** [table, trigger] pairs */
  triggers?: [string, string][]
  note?: string
  /** Dark-build migration: not applied to prod until its Launch Gate. */
  staged?: boolean
}

// ─── THE MANIFEST — one entry per migration file + policies.sql ──────────────
const MANIFEST: Entry[] = [
  {
    file: '0000_robust_phalanx.sql',
    tables: [
      'users', 'msme_profiles', 'provider_profiles', 'provider_verifications',
      'provider_bank_accounts', 'categories', 'provider_categories', 'packages',
      'rfqs', 'rfq_matches', 'quotes', 'orders', 'order_events',
      'order_milestones', 'order_documents', 'payments', 'refunds', 'payouts',
      'disputes', 'reviews', 'conversations', 'messages', 'saved_providers',
      'notifications', 'coupons', 'coupon_redemptions', 'invoices',
      'audit_logs', 'cms_banners',
    ],
    functions: ['set_updated_at', 'generate_order_number', 'packages_tsv_update'],
    triggers: [['packages', 'packages_tsv_trigger']],
  },
  { file: '0001_catalog_search.sql', functions: ['search_packages'] },
  { file: '0002_checkout_sessions.sql', tables: ['checkout_sessions'] },
  { file: '0003_materialize_order.sql', functions: ['materialize_order'] },
  { file: '0004_provider_column_privileges.sql', note: 'grants only — no structural objects' },
  { file: '0005_msme_state_nullable.sql', note: 'column alteration only' },
  { file: '0006_users_phone_nullable.sql', note: 'column alteration only' },
  { file: '0007_search_headline_credential.sql', functions: ['search_packages'] },
  { file: '0008_orders_external_wait.sql', note: 'column addition only (orders.external_wait_since)' },
  { file: '0009_rfq_quote_slot.sql', functions: ['claim_quote_slot', 'release_quote_slot'] },
  { file: '0010_reviews_coupons_engagement.sql', functions: ['recompute_provider_rating', 'increment_coupon_usage'] },
  { file: '0011_cms_hero_banner.sql', note: 'column additions + CHECK on cms_banners' },
  { file: '0012_rfq_voice_meta.sql', note: 'column addition only (rfqs.voice_meta)' },
  { file: '0013_ai_invocations.sql', tables: ['ai_invocations'] },
  { file: '0014_cron_heartbeats.sql', tables: ['cron_heartbeats'] },
  { file: '0015_provider_depth.sql', note: 'column additions only (years_experience, website)' },
  {
    file: '0016_quote_events_score_inputs.sql',
    tables: ['quote_events', 'bank_account_verifications'],
    views: ['provider_score_inputs_v1'],
    triggers: [['quote_events', 'quote_events_no_update']],
  },
  {
    file: '0017_terms_acceptances_refund_key.sql',
    tables: ['terms_acceptances'],
    functions: ['raise_append_only'],
    triggers: [['terms_acceptances', 'terms_acceptances_no_update']],
  },
  { file: '0018_quote_terms.sql', note: 'column additions only (quotes.gst_included/transport_included/valid_until/advance_percent)' },
  {
    file: '0019_order_events_append_only.sql',
    triggers: [['order_events', 'order_events_no_update']],
    note: 'trigger + REVOKE; reuses raise_append_only() from 0017',
  },
  {
    file: '0020_order_kind_columns.sql',
    views: ['order_safe_view', 'provider_score_inputs_v1'],
    note: 'kind columns on orders + checkout_sessions (defaults, no writer); safe-view rebuild; score view kind-scoped',
  },
  { file: '0021_gstin_verifications.sql', tables: ['gstin_verifications'] },
  {
    // AMC Mart M0 — STAGED (dark build): MISSING on prod is EXPECTED until the
    // Launch Gate deploy applies it. Set MART_MIGRATIONS_EXPECTED=false to
    // downgrade its rows to 'skipped' while verifying prod during the build.
    file: '0022_mart_catalog.sql',
    tables: ['mart_categories', 'mart_settings', 'products', 'price_tiers', 'product_events', 'ai_decisions'],
    views: ['order_safe_view'],
    functions: ['materialize_order'],
    triggers: [['product_events', 'product_events_no_update'], ['ai_decisions', 'ai_decisions_no_update']],
    staged: true,
  },
  {
    // AMC Mart M1 — STAGED with 0022 (same Launch Gate deploy).
    file: '0023_mart_pools.sql',
    tables: ['pools', 'pool_members', 'pool_events'],
    views: ['buyer_pool_discipline_v1'],
    triggers: [['pool_events', 'pool_events_no_update']],
    staged: true,
  },
  {
    // AMC Mart M2 — STAGED with 0022/0023: goods columns on rfqs + quotes.
    file: '0024_mart_goods_rfq.sql',
    note: 'column additions only (rfqs.kind/mart_category_slug/goods_spec; quotes goods terms); category_id nullable for goods',
    staged: true,
  },
  {
    // AMC Mart Launch Gate — STAGED with 0022–0024: mart_categories.return_freight_payer (§9.2).
    file: '0025_mart_launch_config.sql',
    note: 'column addition only (mart_categories.return_freight_payer + CHECK)',
    staged: true,
  },
  {
    // H0 agent groundwork (ADR-008). Applied to prod 2026-09-09 (NOT staged);
    // independent of 0022–0025 — a fresh bootstrap runs it after them.
    file: '0026_agent_runs_events.sql',
    tables: ['agent_runs', 'agent_events'],
    triggers: [['agent_events', 'agent_events_no_update'], ['agent_runs', 'agent_runs_set_updated_at']],
    note: 'also adds nullable routing/token columns to ai_invocations',
  },
  {
    // Agent programme S0.1 (ADR-009). Applied to prod BEFORE the writer deploys
    // (NOT staged). ai_decisions is LIFTED here out of staged Mart 0022 into an
    // always-applied table — so on prod it exists via 0027, not 0022 (whose
    // entry above stays staged/skipped). agent_runs gains parent_run_id/job_id.
    file: '0027_agent_foundation.sql',
    tables: ['ai_decisions', 'agent_settings', 'agent_grants'],
    triggers: [
      ['ai_decisions', 'ai_decisions_no_update'],
      ['agent_settings', 'agent_settings_set_updated_at'],
      ['agent_grants', 'agent_grants_set_updated_at'],
    ],
    note: 'lifts ai_decisions out of staged 0022; adds agent_settings + agent_grants; agent_runs parent_run_id/job_id',
  },
  {
    // Services evidence engine (S0.3). Additive columns on order_milestones
    // (kind/photo_doc_id/note/created_by) + partial unique + RLS tightened to
    // parties-read. Applied to prod before/with the writer (NOT staged).
    file: '0028_order_milestone_evidence.sql',
    note: 'column additions + partial unique index on order_milestones; RLS read-only for parties',
  },
  {
    // Trust mechanics (S0.4). rfq_matches decline columns, quote_events CHECK
    // widened, udyam_verifications (mirror of 0021), provider_profiles
    // .udyam_verified, provider_score_inputs_v1 rebuilt (appended columns).
    // Applied to prod before/with the writer (NOT staged).
    file: '0029_trust_mechanics.sql',
    tables: ['udyam_verifications'],
    views: ['provider_score_inputs_v1'],
    note: 'rfq_matches.declined_at/decline_reason; provider_profiles.udyam_verified; score view appended columns',
  },
  {
    // WhatsApp rails (S0.5): conversation store + message log, service-role
    // writes, admin read. Applied to prod before/with the writer (NOT staged).
    file: '0030_whatsapp_rails.sql',
    tables: ['wa_conversations', 'wa_messages'],
    triggers: [['wa_conversations', 'wa_conversations_set_updated_at']],
  },
  {
    // Payout dossiers (S1.4): evidence bundle + RULE recommendation + founder
    // decision (written once — trigger), and per-photo dHash telemetry.
    // Applied to prod before/with the writer (NOT staged).
    file: '0031_payout_dossiers.sql',
    tables: ['payout_dossiers', 'evidence_photo_hashes'],
    triggers: [['payout_dossiers', 'payout_dossiers_decision_guard']],
    note: 'payout_dossiers (UNIQUE order_id+run_id; decision columns immutable once set) + evidence_photo_hashes',
  },
  {
    // Quote extraction (S1.1): the bounded-call proposals + the provider price
    // book; quotes.extraction_id / extraction_confirmed_at. Applied to prod
    // before/with the writer (NOT staged).
    file: '0032_quote_extraction.sql',
    tables: ['quote_extractions', 'provider_price_book'],
    triggers: [
      ['quote_extractions', 'quote_extractions_set_updated_at'],
      ['provider_price_book', 'provider_price_book_set_updated_at'],
    ],
    note: 'quote_extractions + provider_price_book; quotes.extraction_id (partial unique) + extraction_confirmed_at',
  },
  {
    // Buyer decline + compare pointers (S1.2): quotes.decline_* columns (+ column-level
    // privileges hiding decline_note from clients), rfqs.compare_pointers cache.
    // Applied to prod before/with the writer (NOT staged).
    file: '0033_quote_compare_decline.sql',
    tables: [],
    note: 'quotes.decline_*; rfqs.compare_pointers cache; quotes column privileges (decline_note hidden)',
  },
  {
    file: '0034_rfq_clarifications.sql',
    tables: ['rfq_clarifications'],
    triggers: [['rfq_clarifications', 'rfq_clarifications_set_updated_at']],
    note: 'RFQ clarification threads (RLS: buyer + every matched provider read; no client writes); quotes.revision/revised_at join the 0033 column grant; quote_events CHECK gains revised',
  },
  {
    file: '0035_rfq_quality.sql',
    tables: [],
    note: 'S1.5 two-phase create: rfqs.fanout_at (BACKFILLED to created_at for every pre-0035 row — deferred = fanout_at IS NULL, never a status), quality_report/checked_at/decision/decision_at/decision_id, partial index rfqs_deferred_idx',
  },
  {
    file: '0036_onboarding_sessions.sql',
    tables: ['onboarding_sessions', 'provider_capability_facts'],
    triggers: [
      ['onboarding_sessions', 'onboarding_sessions_set_updated_at'],
      ['provider_capability_facts', 'provider_capability_facts_set_updated_at'],
    ],
    note: 'S1.6 Onboarding agent: onboarding_sessions (scripted WhatsApp interview; one active per user), provider_capability_facts (confirmed facts with ai_decisions provenance), wa_conversations.active_session_id; RLS self + admin read, no client writes',
  },
  {
    file: '0037_dispute_triage.sql',
    tables: ['dispute_statements', 'dispute_triages'],
    triggers: [
      ['dispute_statements', 'dispute_statements_set_updated_at'],
      ['dispute_triages', 'dispute_triages_decision_guard'],
    ],
    note: 'S1.7 party statements (spine; one per party, contact-masked, parties + admin read) and dispute_triages (agent-owned, strict card, decision written once by the resolve route); disputes.triage_id',
  },
  {
    file: '0038_rfq_intake.sql',
    tables: ['rfq_intake_extractions'],
    triggers: [['rfq_intake_extractions', 'rfq_intake_extractions_set_updated_at']],
    note: 'S1.8 voice RFQ v2 / document intake: rfq_intake_extractions (agent-owned; clarify / document / drawing results the buyer confirms with the Create tap; rfq_id + decision_id link); ai_decisions feature CHECK gains rfq_intake',
  },
  {
    file: '0039_agent_events_injection.sql',
    tables: ['agent_events'],
    note: 'S2.1 injection gate: agent_events.kind CHECK restated with injection_suspected (the detector event; logged, never blocking)',
  },
  {
    file: '0040_munshi.sql',
    tables: ['munshi_drafts', 'munshi_provider_state'],
    triggers: [
      ['munshi_drafts', 'munshi_drafts_set_updated_at'],
      ['munshi_provider_state', 'munshi_provider_state_set_updated_at'],
    ],
    note: 'S2.2 Digital Munshi: munshi_drafts (proposals the provider decides on) + munshi_provider_state (scan cursor, daily cap, reminders); provider_price_book gains accepted_at / deleted_at / source (source_quote_id nullable for manual rows; accepted_at backfilled from accepted quotes); quotes.munshi_draft_id (+ the S1.2 column grant restated); ai_decisions feature CHECK gains munshi_reply',
  },
  {
    file: '0041_support.sql',
    tables: ['support_tickets', 'support_threads', 'support_messages', 'nudges'],
    triggers: [
      ['support_tickets', 'support_tickets_set_updated_at'],
      ['support_threads', 'support_threads_set_updated_at'],
    ],
    note: 'S2.3 Support agent: support_tickets (escalations a human resolves; the agent halts on an open one), support_threads + support_messages (web / mobile chat; user text masked, assistant text = the template), nudges (the counterparty nudge ledger written by the spine routes); wa_conversations support_ticket_id / support_last_intents / support_unclear_streak; ai_decisions feature CHECK gains support_nudge',
  },
  {
    file: '0042_users_privilege_guard.sql',
    tables: ['users'],
    functions: ['users_roles_guard'],
    triggers: [['users', 'users_roles_guard']],
    note: 'Security hotfix: users owner policy is SELECT-only, INSERT/UPDATE/DELETE revoked from anon + authenticated, users_roles_guard refuses a roles change by a client role (closes self-promotion to admin)',
  },
  {
    file: '0043_rls_hardening.sql',
    tables: ['messages', 'order_events', 'audit_logs', 'msme_profiles'],
    triggers: [['audit_logs', 'audit_logs_no_update']],
    note: 'Security hotfix: messages parties SELECT-only + INSERT/UPDATE/DELETE revoked; order_events parties-insert policy dropped + INSERT revoked; audit_logs append-only trigger (raise_append_only from 0017) + INSERT/UPDATE/DELETE revoked; msme_profiles owner SELECT-only + INSERT/UPDATE/DELETE revoked (no self-unsuspend / self-verify) — all from anon + authenticated (service role keeps its grants)',
  },
  {
    file: '0044_amc_score.sql',
    tables: ['provider_scores', 'buyer_scores', 'score_history', 'score_events'],
    functions: ['score_inputs_provider', 'score_inputs_buyer'],
    triggers: [
      ['provider_scores', 'provider_scores_set_updated_at'],
      ['buyer_scores', 'buyer_scores_set_updated_at'],
      ['score_events', 'score_events_no_update'],
    ],
    note: 'S2.4 AMC Score v1 (ADR-010): score_inputs_provider / score_inputs_buyer (SECURITY INVOKER, services only, 90-day window; service_role EXECUTE only), provider_scores + buyer_scores (latest snapshot per subject x version), score_history (one row per subject per day), score_events (append-only); munshi_provider_state.last_growth_at',
  },
  {
    file: '0045_procurement.sql',
    tables: ['procurement_sessions', 'procurement_turns'],
    triggers: [
      ['procurement_sessions', 'procurement_sessions_set_updated_at'],
      ['procurement_turns', 'procurement_turns_set_updated_at'],
    ],
    note: 'S3.1 Buyer Procurement Agent (dark; A2 at the V1.5 -> V2 gate): procurement_sessions (one per need; one ACTIVE per user x rfq), procurement_turns (the web mirror thread), wa_conversations.procurement_session_id, ai_decisions feature procurement_step; clients SELECT only',
  },
  {
    file: '0046_benchmarks.sql',
    tables: ['price_benchmarks'],
    functions: ['benchmark_inputs', 'replace_price_benchmarks'],
    triggers: [['price_benchmarks', 'price_benchmarks_set_updated_at']],
    note: 'S3.2 fair price ranges (dark): price_benchmarks (aggregates only, no id column), benchmark_inputs() + replace_price_benchmarks() (service_role only); any signed-in user reads, clients SELECT only',
  },
  {
    file: '0047_search_weighted_rating.sql',
    functions: ['search_packages'],
    note: 'E0 / U9: search_packages ordering drops top_rated; "rating" is review-count weighted (same signature as 0007)',
  },
  { file: '0048_ui_density.sql', note: 'E1 / N33: users.ui_density (comfortable | compact | NULL) + CHECK; written by the service role only' },
  {
    file: '0049_trust_v3.sql',
    tables: ['provider_public_stats'],
    triggers: [['provider_public_stats', 'provider_public_stats_set_updated_at']],
    note: 'E3: provider_public_stats (service role only), provider_verifications expires_at/evidence_hash, provider_profiles next_available_on/capacity_slots/logo_status/logo_pending_url',
  },
  {
    file: '0050_packages_v3.sql',
    tables: ['package_groups'],
    triggers: [['package_groups', 'package_groups_set_updated_at'], ['packages', 'packages_group_same_provider']],
    functions: ['packages_group_same_provider'],
    note: 'E4: package_groups (tiers), packages group_id/tier/ideal_for_i18n/compare_values/govt_dependent_override, categories.govt_dependent',
  },
  {
    file: '0051_search_v2.sql',
    tables: ['search_feedback'],
    functions: ['search_packages_v2', 'search_facets_v2'],
    triggers: [['search_feedback', 'search_feedback_set_updated_at']],
    note: 'E2a: search_packages_v2 + search_facets_v2 (v1 untouched), packages.service_slug, search_feedback (service role only)',
  },
  {
    file: '0052_recent_views.sql',
    tables: ['recent_views'],
    triggers: [['recent_views', 'recent_views_set_updated_at']],
    note: 'E2b / N8: recent_views (owner-only RLS; last 20 provider/package views per user)',
  },
  {
    file: '0053_requirements_v3.sql',
    tables: ['service_document_requirements', 'quote_sla_stats'],
    functions: ['refresh_quote_sla_stats'],
    triggers: [['service_document_requirements', 'service_document_requirements_set_updated_at'], ['quote_sla_stats', 'quote_sla_stats_set_updated_at']],
    note: 'E6: rfqs.must_haves (display-only), service_document_requirements (unreviewed seed; public read), quote_sla_stats + refresh_quote_sla_stats() (service role)',
  },
  {
    file: '0054_licences_obligations.sql',
    tables: ['buyer_licences', 'order_licence_facts', 'licence_reminders', 'obligation_rules'],
    triggers: [['buyer_licences', 'buyer_licences_set_updated_at'], ['order_licence_facts', 'order_licence_facts_set_updated_at'], ['obligation_rules', 'obligation_rules_set_updated_at']],
    note: 'E9b / N45 (D-PRD5, dark): buyer_licences (owner RLS, soft delete), order_licence_facts + licence_reminders (service role), obligation_rules (unreviewed seed; reviewed rows public)',
  },
  {
    file: '0055_onboarding_v3.sql',
    tables: ['provider_onboarding_progress', 'onboarding_nudges'],
    triggers: [['provider_onboarding_progress', 'provider_onboarding_progress_set_updated_at']],
    note: 'E10 / N27c: provider_onboarding_progress (last step per applicant) + onboarding_nudges (<= 2, PK idempotent); service role only',
  },
  {
    file: '0056_view_counts.sql',
    tables: ['view_counts_daily'],
    functions: ['bump_view_count'],
    triggers: [['view_counts_daily', 'view_counts_daily_set_updated_at']],
    note: 'E11 / N29: view_counts_daily (provider reads own; written only by bump_view_count(), service role, from the rate-limited beacon)',
  },
  {
    file: '0057_tenders_cms_pages.sql',
    tables: ['tender_alerts', 'tender_feedback', 'cms_pages'],
    triggers: [['tender_alerts', 'tender_alerts_set_updated_at'], ['tender_feedback', 'tender_feedback_set_updated_at'], ['cms_pages', 'cms_pages_set_updated_at']],
    note: 'E11c / N30 (D9, dark): tender_alerts + tender_feedback (service role; alerts only, no bidding), cms_pages (fresh reviewed rows readable; GeM checklist seeded unreviewed)',
  },
  {
    file: '0058_quote_loss_labels.sql',
    tables: [],
    note: "E7 / N22: quote_events CHECK gains 'lost'; quote_events_lost_once (one label per quote); provider read policy excludes 'lost' rows",
  },
  {
    file: '0059_order_messages.sql',
    tables: [],
    note: "E8b / N24: order threads reuse conversations (context_type 'order'); conversations parties read-only + writes revoked; admin read on conversations + messages; messages_conversation_created_idx",
  },
  {
    file: '0060_category_names_te_ta.sql',
    tables: [],
    note: 'E14 / FR-14.2: te + ta slots merged into categories.name_i18n / description_i18n (data only)',
  },
  {
    file: '0061_content_translations.sql',
    tables: ['content_translations'],
    triggers: [['content_translations', 'content_translations_set_updated_at']],
    note: "E14 / N32b (dark): content_translations (drafts; provider reads own, service role writes); packages.i18n_sources, provider_profiles.about_i18n + i18n_sources; ai_decisions CHECK + 'content_translation'",
  },
  {
    file: '0062_shadow_predictions_specs.sql',
    tables: ['shadow_predictions'],
    triggers: [['shadow_predictions', 'shadow_predictions_set_updated_at']],
    note: 'E15 / F3 + F10: rfqs.cad_features (deterministic CAD parse); shadow_predictions (service role only; subject ids only; 24-month retention)',
  },
  {
    file: '0064_server_written_money.sql',
    tables: [],
    note: 'ADR 018 security hotfix: EXECUTE on materialize_order / claim_quote_slot / release_quote_slot / increment_coupon_usage for service_role only; no client INSERT/UPDATE/DELETE on orders, checkout_sessions, payments, payouts, refunds, invoices, disputes, order_documents, rfqs, quotes, rfq_matches, coupons, coupon_redemptions, provider_bank_accounts, reviews',
  },
  // Not a migration, but bootstrap applies it last and its views must exist.
  { file: 'rls/policies.sql', views: ['order_safe_view', 'public_providers'] },
]

// ─── plumbing ────────────────────────────────────────────────────────────────
const URL = process.env['NEXT_PUBLIC_SUPABASE_URL']
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']
const DB_URL = process.env['DATABASE_URL']
if (!URL || !SERVICE) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in apps/web/.env.local')
  process.exit(2)
}
const rest = createClient(URL, SERVICE, { auth: { persistSession: false } })

type Status = 'present' | 'MISSING' | 'skipped'
const rows: { migration: string; object: string; status: Status }[] = []
let missing = 0

function record(migration: string, object: string, status: Status) {
  rows.push({ migration, object, status })
  if (status === 'MISSING') missing++
}

async function restRelationExists(name: string): Promise<boolean> {
  // NOT head:true — PostgREST answers HEAD with 204 even for nonexistent
  // tables (verified against prod), which made every check pass. A real
  // select with limit(0) errors PGRST205/42P01 on a missing relation.
  const { error } = await rest.from(name).select('*').limit(0)
  if (!error) return true
  // 42P01 undefined_table / PGRST205 not in schema cache → missing.
  if (error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache/i.test(error.message)) {
    return false
  }
  // Any other error (e.g. RLS on a zero-policy table still 200s for service
  // role; unexpected errors) — the relation resolved, so it exists.
  return true
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function main() {
  // Every migration file must have a manifest entry.
  const migrationsDir = path.resolve(__dirname, '../../../packages/db/src/migrations')
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))
  const manifested = new Set(MANIFEST.map((m) => m.file))
  const unmanifested = files.filter((f) => !manifested.has(f))
  if (unmanifested.length > 0) {
    console.error(`✗ Migration files without a manifest entry: ${unmanifested.join(', ')}`)
    console.error('  Add each to MANIFEST in scripts/verify-migrations.ts (definition of done).')
    process.exit(1)
  }

  let sql: any = null
  if (DB_URL) {
    const dbPkg: any = await import('@amclub/db')
    sql = dbPkg.db
  }

  const stagedExpected = process.env['MART_MIGRATIONS_EXPECTED'] !== 'false'
  for (const entry of MANIFEST) {
    if (entry.staged && !stagedExpected) {
      record(entry.file, '(staged — MART_MIGRATIONS_EXPECTED=false)', 'skipped')
      continue
    }
    for (const t of entry.tables ?? []) {
      if (sql) {
        const r = await sql`SELECT to_regclass(${'public.' + t}) AS reg`
        record(entry.file, `table ${t}`, r[0]?.reg ? 'present' : 'MISSING')
      } else {
        record(entry.file, `table ${t}`, (await restRelationExists(t)) ? 'present' : 'MISSING')
      }
    }
    for (const v of entry.views ?? []) {
      if (sql) {
        const r = await sql`SELECT to_regclass(${'public.' + v}) AS reg`
        record(entry.file, `view ${v}`, r[0]?.reg ? 'present' : 'MISSING')
      } else {
        record(entry.file, `view ${v}`, (await restRelationExists(v)) ? 'present' : 'MISSING')
      }
    }
    for (const f of entry.functions ?? []) {
      if (sql) {
        const r = await sql`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ${f}`
        record(entry.file, `function ${f}`, r[0]?.n > 0 ? 'present' : 'MISSING')
      } else {
        record(entry.file, `function ${f}`, 'skipped')
      }
    }
    for (const [table, trig] of entry.triggers ?? []) {
      if (sql) {
        const r = await sql`SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = ${table} AND t.tgname = ${trig} AND NOT t.tgisinternal`
        record(entry.file, `trigger ${trig} ON ${table}`, r[0]?.n > 0 ? 'present' : 'MISSING')
      } else {
        record(entry.file, `trigger ${trig} ON ${table}`, 'skipped')
      }
    }
    if (!entry.tables && !entry.views && !entry.functions && !entry.triggers) {
      record(entry.file, `(${entry.note ?? 'no structural objects'})`, 'present')
    }
  }

  // Report table
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s.padEnd(n))
  console.log(`\nverify-migrations → ${URL} ${sql ? '(SQL mode — authoritative)' : '(REST mode — functions/triggers skipped; set DATABASE_URL for full checks)'}\n`)
  for (const r of rows) {
    const mark = r.status === 'present' ? '✓' : r.status === 'skipped' ? '⏭' : '✗'
    console.log(`  ${mark} ${pad(r.migration, 42)} ${pad(r.object, 48)} ${r.status}`)
  }
  const skipped = rows.filter((r) => r.status === 'skipped').length
  console.log(`\n${missing === 0 ? '✅' : '❌'} ${rows.length} checks: ${rows.length - missing - skipped} present, ${skipped} skipped, ${missing} MISSING\n`)
  if (sql) await sql.end?.()
  process.exit(missing === 0 ? 0 : 1)
}
main().catch((e) => {
  console.error(e)
  process.exit(2)
})
