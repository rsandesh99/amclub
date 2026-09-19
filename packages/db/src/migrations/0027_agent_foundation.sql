-- Agent programme S0.1 — foundation (ADR-009 §1-§8, docs/agents/ARCHITECTURE.md).
-- Additive, idempotent, and NOT staged: agent tables are inert without a
-- surface and no read-path is poisoned by a premature column, so this applies
-- to prod BEFORE the token/grants writer deploys (RULES.md 2, opposite of Mart).
--
-- 1. ai_decisions — LIFTED out of the staged Mart 0022 into an always-applied
--    table. On prod (0022 not yet applied) this CREATE builds it fresh; on a
--    full-Mart bootstrap the IF NOT EXISTS is a no-op and 0022 stays
--    byte-identical. The feature CHECK is widened to the whole programme and
--    two nullable columns (run_id, tool) tie a confirmation to a runtime run.
--    This is the ONE confirmation ledger reconciling Mart + runtime agents.
-- 2. agent_settings — the config registry (mirrors mart_settings): agents_enabled
--    per agent, budget caps, cohort ids, consent versions. Writes via service
--    role from the admin route only; admin/ops read.
-- 3. agent_grants — delegated-identity consent: which persona, which scopes,
--    which channel, with a consent snapshot. The token endpoint refuses a
--    runtime credential without an active grant.
-- 4. agent_runs — parent_run_id + job_id for resumable / chained work.
--
-- RLS mirrored in rls/policies.sql; ai_decisions moves from the $mart$ guarded
-- block into the always-applied section. Manifest entry in verify-migrations.ts.

-- ─── 1. ai_decisions — lifted from staged 0022 (same DDL), then extended ──────
CREATE TABLE IF NOT EXISTS ai_decisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- catalog_draft | payout_dossier | extraction_correction (0022); widened below
  feature          text NOT NULL,
  input_refs       jsonb NOT NULL,
  proposed         jsonb NOT NULL,
  final            jsonb NOT NULL,
  corrected_fields text[] NOT NULL DEFAULT '{}',
  decided_by       uuid NOT NULL REFERENCES users(id),
  decided_at       timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_decisions_feature_check CHECK (feature IN ('catalog_draft', 'payout_dossier', 'extraction_correction'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_decisions_feature_idx ON ai_decisions (feature, decided_at);
--> statement-breakpoint
DROP TRIGGER IF EXISTS ai_decisions_no_update ON ai_decisions;
--> statement-breakpoint
CREATE TRIGGER ai_decisions_no_update
  BEFORE UPDATE ON ai_decisions
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON ai_decisions FROM anon, authenticated;
--> statement-breakpoint
-- Widen the feature CHECK to the whole programme (superset of 0022 + 0023).
ALTER TABLE ai_decisions DROP CONSTRAINT IF EXISTS ai_decisions_feature_check;
--> statement-breakpoint
ALTER TABLE ai_decisions ADD CONSTRAINT ai_decisions_feature_check CHECK (feature IN (
  'catalog_draft', 'payout_dossier', 'extraction_correction',
  'pool_draft', 'pool_card', 'documents_draft',
  'agent_tool', 'quote_extraction', 'decline_message', 'onboarding',
  'dispute_triage', 'rfq_quality', 'munshi_draft', 'support_reply', 'score_note'
));
--> statement-breakpoint
-- Runtime linkage: which run + tool this confirmation approved (null for Mart).
ALTER TABLE ai_decisions ADD COLUMN IF NOT EXISTS run_id uuid;
--> statement-breakpoint
ALTER TABLE ai_decisions ADD COLUMN IF NOT EXISTS tool text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_decisions_run_idx ON ai_decisions (run_id) WHERE run_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE ai_decisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "ai_decisions: self read" ON ai_decisions;
--> statement-breakpoint
CREATE POLICY "ai_decisions: self read" ON ai_decisions
  FOR SELECT USING (decided_by = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "ai_decisions: admin read" ON ai_decisions;
--> statement-breakpoint
CREATE POLICY "ai_decisions: admin read" ON ai_decisions
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT ON ai_decisions FROM anon, authenticated;
--> statement-breakpoint

-- ─── 2. agent_settings — closed config registry (mirrors mart_settings) ───────
CREATE TABLE IF NOT EXISTS agent_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_settings_set_updated_at ON agent_settings;
--> statement-breakpoint
CREATE TRIGGER agent_settings_set_updated_at
  BEFORE UPDATE ON agent_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE agent_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_settings: admin read" ON agent_settings;
--> statement-breakpoint
CREATE POLICY "agent_settings: admin read" ON agent_settings
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON agent_settings FROM anon, authenticated;
--> statement-breakpoint

-- ─── 3. agent_grants — delegated-identity consent ────────────────────────────
CREATE TABLE IF NOT EXISTS agent_grants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- AGENT_PERSONAS
  persona          text NOT NULL CHECK (persona IN ('buyer', 'provider', 'ops')),
  -- ⊆ toolsForPersona(persona) (validated by the route against @amclub/shared)
  scopes           text[] NOT NULL DEFAULT '{}',
  -- where the grant applies
  channel          text NOT NULL CHECK (channel IN ('web', 'mobile', 'whatsapp')),
  -- e.g. E.164 phone for whatsapp; null otherwise
  channel_identity text,
  -- consent snapshot: { locale, surface, ip, user_agent, text_version }
  consent          jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz
);
--> statement-breakpoint
-- At most one active grant per (user, persona, channel).
CREATE UNIQUE INDEX IF NOT EXISTS agent_grants_active_uniq
  ON agent_grants (user_id, persona, channel) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_grants_user_idx ON agent_grants (user_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
-- Resolve a whatsapp grant by phone at inbound time (S0.5).
CREATE INDEX IF NOT EXISTS agent_grants_channel_identity_idx
  ON agent_grants (channel, channel_identity) WHERE revoked_at IS NULL AND channel_identity IS NOT NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_grants_set_updated_at ON agent_grants;
--> statement-breakpoint
CREATE TRIGGER agent_grants_set_updated_at
  BEFORE UPDATE ON agent_grants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE agent_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_grants: self read" ON agent_grants;
--> statement-breakpoint
CREATE POLICY "agent_grants: self read" ON agent_grants
  FOR SELECT USING (user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_grants: self insert" ON agent_grants;
--> statement-breakpoint
CREATE POLICY "agent_grants: self insert" ON agent_grants
  FOR INSERT WITH CHECK (user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_grants: self revoke" ON agent_grants;
--> statement-breakpoint
CREATE POLICY "agent_grants: self revoke" ON agent_grants
  FOR UPDATE USING (user_id = auth_user_id()) WITH CHECK (user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_grants: admin read" ON agent_grants;
--> statement-breakpoint
CREATE POLICY "agent_grants: admin read" ON agent_grants
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
-- Self may INSERT (own rows) and UPDATE ONLY revoked_at; never DELETE, never edit
-- persona/scopes/consent after the fact. Column-scoped UPDATE grant enforces it.
REVOKE UPDATE, DELETE ON agent_grants FROM anon, authenticated;
--> statement-breakpoint
GRANT UPDATE (revoked_at) ON agent_grants TO authenticated;
--> statement-breakpoint

-- ─── 4. agent_runs — chained / resumable work ────────────────────────────────
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS parent_run_id uuid;
--> statement-breakpoint
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS job_id text;
--> statement-breakpoint
-- agent_runs.surface has no CHECK (0026 left it free text); 'system' is already
-- accepted. No CHECK to widen. parent_run_id references agent_runs(id) logically
-- (no FK to keep it additive/idempotent and avoid a self-cascade lock).
CREATE INDEX IF NOT EXISTS agent_runs_parent_idx ON agent_runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
