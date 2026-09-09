-- H0 agent groundwork (DESIGN.md §8.6, ADR-008) — additive only.
--
-- 1. ai_invocations gains routing + token columns so the existing voice
--    pipeline (and every later agent step) is attributable to a task class
--    and cost tier. All nullable; old writers keep working unchanged.
-- 2. agent_runs — one row per agent task on behalf of one user (persona,
--    status per AGENT_RUN_TRANSITIONS in @amclub/shared, budget counters).
-- 3. agent_events — append-only trace of a run (started / model_call /
--    tool_proposed / confirmation_requested / confirmed / declined /
--    tool_called / completed / failed / cancelled). Same trigger + REVOKE
--    posture as order_events (0019) / quote_events (0016).
--
-- RLS: self read + admin read on both tables; NO client write policies and
-- INSERT/UPDATE/DELETE revoked — the runtime writes via service role after
-- its own authorisation check (ADR-008 §Delegated identity). Nothing here
-- is reachable from any client until AGENT_ENABLED surfaces exist.
--
-- Idempotent; safe to re-run. Apply BEFORE deploying the writer (additive,
-- old code unaffected) — RULES.md rule 2.

ALTER TABLE ai_invocations ADD COLUMN IF NOT EXISTS run_id uuid;
--> statement-breakpoint
ALTER TABLE ai_invocations ADD COLUMN IF NOT EXISTS task_class text;
--> statement-breakpoint
ALTER TABLE ai_invocations ADD COLUMN IF NOT EXISTS tier text;
--> statement-breakpoint
ALTER TABLE ai_invocations ADD COLUMN IF NOT EXISTS input_tokens integer;
--> statement-breakpoint
ALTER TABLE ai_invocations ADD COLUMN IF NOT EXISTS output_tokens integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_invocations_run_idx ON ai_invocations (run_id) WHERE run_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_invocations_task_class_created_idx
  ON ai_invocations (task_class, created_at) WHERE task_class IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS agent_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'buyer' | 'provider' | 'ops' (AGENT_PERSONAS)
  persona       text NOT NULL CHECK (persona IN ('buyer', 'provider', 'ops')),
  -- AGENT_RUN_STATUSES; transitions enforced by the runtime via the shared map
  status        text NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'awaiting_confirmation', 'completed', 'failed', 'cancelled')),
  -- 'web' | 'mobile' | 'whatsapp' | 'phone' — where the run was opened
  surface       text NOT NULL,
  -- optional anchor: the entity this run is about (rfq / order / quote id)
  subject_type  text,
  subject_id    uuid,
  -- budget counters (paise estimate + tokens), summed from ai_invocations
  cost_est_paise bigint NOT NULL DEFAULT 0,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  error         text,
  meta          jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_runs_user_created_idx ON agent_runs (user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_runs_status_idx ON agent_runs (status) WHERE status IN ('running', 'awaiting_confirmation');
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_runs_set_updated_at ON agent_runs;
--> statement-breakpoint
CREATE TRIGGER agent_runs_set_updated_at
  BEFORE UPDATE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_runs: self read" ON agent_runs;
--> statement-breakpoint
CREATE POLICY "agent_runs: self read" ON agent_runs
  FOR SELECT USING (user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_runs: admin read" ON agent_runs;
--> statement-breakpoint
CREATE POLICY "agent_runs: admin read" ON agent_runs
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON agent_runs FROM anon, authenticated;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS agent_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  -- AGENT_EVENT_KINDS
  kind        text NOT NULL CHECK (kind IN (
                'started', 'model_call', 'tool_proposed', 'confirmation_requested',
                'confirmed', 'declined', 'tool_called', 'completed', 'failed', 'cancelled')),
  -- AGENT_TOOLS name for tool_* / confirmation_* events
  tool        text,
  -- 'agent' | 'user' | 'system' — who caused the event
  actor       text NOT NULL DEFAULT 'agent' CHECK (actor IN ('agent', 'user', 'system')),
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_events_run_created_idx ON agent_events (run_id, created_at);
--> statement-breakpoint
-- Append-only: same guard as order_events (0019). raise_append_only() from 0017.
DROP TRIGGER IF EXISTS agent_events_no_update ON agent_events;
--> statement-breakpoint
CREATE TRIGGER agent_events_no_update
  BEFORE UPDATE ON agent_events
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
--> statement-breakpoint
ALTER TABLE agent_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_events: self read" ON agent_events;
--> statement-breakpoint
CREATE POLICY "agent_events: self read" ON agent_events
  FOR SELECT USING (run_id IN (SELECT id FROM agent_runs WHERE user_id = auth_user_id()));
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_events: admin read" ON agent_events;
--> statement-breakpoint
CREATE POLICY "agent_events: admin read" ON agent_events
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON agent_events FROM anon, authenticated;
