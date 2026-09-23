-- Buyer Procurement Agent (BUILD_PROMPTS S3.1, A2) — additive, idempotent, NOT staged
-- (apply to prod before the writer deploys, RULES.md 2). Built dark: nothing
-- writes these tables until AGENT_ENABLED + agents_enabled.procurement + the
-- cohort + the buyer's own grant; enablement is gated by DESIGN §8.2 / §8.6
-- (A2 sits at the V1.5 → V2 gate) and needs its own §8.1 mini-PRD.
--
-- procurement_sessions (agent-owned): one row per buyer need the agent follows,
-- from the draft to the closed request. `state` is the machine in
-- packages/shared/src/state-machines.ts (PROCUREMENT_SESSION_TRANSITIONS);
-- `draft` is the RFQ create body being proposed (+ the parse / clarify prior),
-- `pending` what the agent is waiting for from the buyer (a clarify answer, the
-- S1.5 quality answers, a relayed provider question, a label pick), `labels`
-- quote id → the letter the compare page shows, `last_seen` the clarification /
-- quote ids already handled, `open_run_id` the parked proposal. One ACTIVE
-- session per (user, rfq). Written by the runtime (service role) and the web
-- enable / message routes AFTER the session check — clients never write.
--
-- procurement_turns (agent-owned): the thread the web mirror shows — both the
-- WhatsApp and the web turns. User bodies are stored contact-masked; agent
-- bodies are the rendered templates; `proposal` carries refs only (run id, tool,
-- status). Append-only in practice (soft delete for erasure).
--
-- wa_conversations.procurement_session_id: the dispatcher's O(1) route for a
-- WhatsApp message while a session is active (the S1.6 active_session_id
-- precedent).
--
-- ai_decisions_feature_check restated with 'procurement_step' (every buyer
-- confirmation of a procurement proposal: create_rfq, complete_rfq,
-- answer_clarification, message_provider, decline_quote, choose_quote, and the
-- chase nudge).
--
-- RLS: the buyer reads their own rows; admin / ops read all. Clients get SELECT
-- only (REVOKE ALL, GRANT SELECT — the S2.4 / PR #15 rule); only the service
-- role writes.

CREATE TABLE IF NOT EXISTS procurement_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  msme_id          uuid NOT NULL REFERENCES msme_profiles(id),
  rfq_id           uuid REFERENCES rfqs(id),
  root_run_id      uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  open_run_id      uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  conversation_id  uuid REFERENCES wa_conversations(id) ON DELETE SET NULL,
  surface          text NOT NULL CHECK (surface IN ('whatsapp', 'web', 'mobile')),
  state            text NOT NULL DEFAULT 'drafting' CHECK (state IN ('drafting', 'awaiting_create', 'quality', 'live', 'quotes_in', 'chosen', 'closed', 'expired', 'failed')),
  locale           text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'hi', 'te', 'ta')),
  title            text,
  draft            jsonb,
  pending          jsonb,
  labels           jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen        jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposals_today  integer NOT NULL DEFAULT 0,
  proposals_date   date,
  last_chase_at    timestamptz,
  close_reason     text,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS procurement_sessions_user_updated_idx ON procurement_sessions (user_id, updated_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS procurement_sessions_state_idx ON procurement_sessions (state) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- One ACTIVE session per (user, rfq): the watcher follows a request once.
CREATE UNIQUE INDEX IF NOT EXISTS procurement_sessions_active_user_rfq_uidx
  ON procurement_sessions (user_id, rfq_id)
  WHERE rfq_id IS NOT NULL AND state NOT IN ('closed', 'expired', 'failed') AND deleted_at IS NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS procurement_sessions_set_updated_at ON procurement_sessions;
--> statement-breakpoint
CREATE TRIGGER procurement_sessions_set_updated_at
  BEFORE UPDATE ON procurement_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS procurement_turns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL REFERENCES procurement_sessions(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id),
  role           text NOT NULL CHECK (role IN ('user', 'agent', 'system')),
  surface        text NOT NULL CHECK (surface IN ('whatsapp', 'web', 'mobile')),
  body           text,
  wa_message_id  uuid REFERENCES wa_messages(id) ON DELETE SET NULL,
  run_id         uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  proposal       jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS procurement_turns_session_created_idx ON procurement_turns (session_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS procurement_turns_run_idx ON procurement_turns (run_id) WHERE run_id IS NOT NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS procurement_turns_set_updated_at ON procurement_turns;
--> statement-breakpoint
CREATE TRIGGER procurement_turns_set_updated_at
  BEFORE UPDATE ON procurement_turns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ── wa_conversations: the dispatcher's route to the active session ─────────
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS procurement_session_id uuid REFERENCES procurement_sessions(id) ON DELETE SET NULL;
--> statement-breakpoint

-- ── ai_decisions feature CHECK restated with procurement_step ──────────────
ALTER TABLE ai_decisions DROP CONSTRAINT IF EXISTS ai_decisions_feature_check;
--> statement-breakpoint
ALTER TABLE ai_decisions ADD CONSTRAINT ai_decisions_feature_check CHECK (feature IN (
  'catalog_draft', 'payout_dossier', 'extraction_correction',
  'pool_draft', 'pool_card', 'documents_draft',
  'agent_tool', 'quote_extraction', 'decline_message', 'onboarding',
  'dispute_triage', 'rfq_quality', 'munshi_draft', 'support_reply', 'score_note',
  'rfq_intake', 'munshi_reply', 'support_nudge', 'procurement_step'
));
--> statement-breakpoint

-- ── RLS (clients: SELECT only; RLS picks the rows) ──────────────────────────
ALTER TABLE procurement_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "procurement_sessions: owner read" ON procurement_sessions;
--> statement-breakpoint
CREATE POLICY "procurement_sessions: owner read" ON procurement_sessions
  FOR SELECT USING (deleted_at IS NULL AND user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "procurement_sessions: admin read" ON procurement_sessions;
--> statement-breakpoint
CREATE POLICY "procurement_sessions: admin read" ON procurement_sessions
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE ALL ON procurement_sessions FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON procurement_sessions TO authenticated;
--> statement-breakpoint
ALTER TABLE procurement_turns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "procurement_turns: owner read" ON procurement_turns;
--> statement-breakpoint
CREATE POLICY "procurement_turns: owner read" ON procurement_turns
  FOR SELECT USING (deleted_at IS NULL AND user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "procurement_turns: admin read" ON procurement_turns;
--> statement-breakpoint
CREATE POLICY "procurement_turns: admin read" ON procurement_turns
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE ALL ON procurement_turns FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON procurement_turns TO authenticated;
