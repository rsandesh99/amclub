-- Support Agent (BUILD_PROMPTS S2.3) — additive, idempotent, NOT staged
-- (apply to prod before the writer deploys, RULES.md 2).
--
-- support_tickets (agent-owned): one row per escalation — a complaint, dispute
-- language, a payment problem, a request for a human, or two unresolved
-- turns. `summary` / `suggested_next` are the model's OPS-FACING summary
-- (contact rule applied); the user only ever sees a template. An OPEN ticket
-- halts the agent on that conversation / thread until a human resolves it at
-- /admin/support. One open ticket per (user, channel).
--
-- support_threads / support_messages (agent-owned): the web / mobile chat.
-- User text is stored contact-masked (`redacted`); assistant text is the
-- rendered template; `lookup_refs` are ids only. Written by the web route
-- with the service role AFTER the session check (the model call and the
-- two-table write happen server-side) — clients never insert.
--
-- nudges (spine): the counterparty nudge ledger, written by the ordinary
-- routes POST /orders/[id]/nudge and POST /rfq/[id]/nudge; the cap (one per
-- sender per subject per cooldown) is a route check on created_at.
--
-- wa_conversations gains the support ticket pointer + the classifier history
-- (intents only, never text) and the unclear streak.
--
-- ai_decisions_feature_check restated with 'support_nudge'.
-- RLS: user reads own; admin / ops read all; no client writes.

CREATE TABLE IF NOT EXISTS support_tickets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  role             text NOT NULL CHECK (role IN ('buyer', 'provider')),
  channel          text NOT NULL CHECK (channel IN ('whatsapp', 'web', 'mobile')),
  conversation_id  uuid REFERENCES wa_conversations(id) ON DELETE SET NULL,
  thread_id        uuid,
  order_id         uuid REFERENCES orders(id),
  rfq_id           uuid REFERENCES rfqs(id),
  intent           text,
  reason           text NOT NULL,
  summary          text,
  suggested_next   text,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  assigned_to      uuid REFERENCES users(id),
  acknowledged_at  timestamptz,
  resolved_at      timestamptz,
  resolved_by      uuid REFERENCES users(id),
  resolution_note  text,
  run_id           uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS support_tickets_status_created_idx ON support_tickets (status, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS support_tickets_user_created_idx ON support_tickets (user_id, created_at DESC);
--> statement-breakpoint
-- One OPEN ticket per (user, channel): a second escalation joins the open one.
CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_open_user_channel_uidx
  ON support_tickets (user_id, channel)
  WHERE status <> 'resolved' AND deleted_at IS NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS support_tickets_set_updated_at ON support_tickets;
--> statement-breakpoint
CREATE TRIGGER support_tickets_set_updated_at
  BEFORE UPDATE ON support_tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS support_threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  role            text NOT NULL CHECK (role IN ('buyer', 'provider')),
  locale          text NOT NULL DEFAULT 'en',
  -- the last intents (strings), never message text
  last_intents    jsonb NOT NULL DEFAULT '[]'::jsonb,
  unclear_streak  integer NOT NULL DEFAULT 0,
  open_ticket_id  uuid REFERENCES support_tickets(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS support_threads_user_idx ON support_threads (user_id, created_at DESC);
--> statement-breakpoint
DROP TRIGGER IF EXISTS support_threads_set_updated_at ON support_threads;
--> statement-breakpoint
CREATE TRIGGER support_threads_set_updated_at
  BEFORE UPDATE ON support_threads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_thread_id_fkey;
--> statement-breakpoint
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES support_threads(id) ON DELETE SET NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS support_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id    uuid NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  -- user text contact-masked (redacted = true when something was masked); assistant text = the rendered template
  body         text NOT NULL,
  redacted     boolean NOT NULL DEFAULT false,
  intent       text,
  reply_key    text,
  -- ids only: { order_id?, rfq_id? }
  lookup_refs  jsonb,
  run_id       uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS support_messages_thread_created_idx ON support_messages (thread_id, created_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS nudges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind  text NOT NULL CHECK (subject_kind IN ('order', 'rfq')),
  subject_id    uuid NOT NULL,
  from_user_id  uuid NOT NULL REFERENCES users(id),
  to_user_id    uuid REFERENCES users(id),
  run_id        uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  decision_id   uuid REFERENCES ai_decisions(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nudges_subject_sender_created_idx ON nudges (subject_kind, subject_id, from_user_id, created_at DESC);
--> statement-breakpoint

-- ── wa_conversations: the support pointer + classifier history ──────────────
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS support_ticket_id uuid REFERENCES support_tickets(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS support_last_intents jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS support_unclear_streak integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- ── ai_decisions feature CHECK restated with support_nudge ──────────────────
ALTER TABLE ai_decisions DROP CONSTRAINT IF EXISTS ai_decisions_feature_check;
--> statement-breakpoint
ALTER TABLE ai_decisions ADD CONSTRAINT ai_decisions_feature_check CHECK (feature IN (
  'catalog_draft', 'payout_dossier', 'extraction_correction',
  'pool_draft', 'pool_card', 'documents_draft',
  'agent_tool', 'quote_extraction', 'decline_message', 'onboarding',
  'dispute_triage', 'rfq_quality', 'munshi_draft', 'support_reply', 'score_note',
  'rfq_intake', 'munshi_reply', 'support_nudge'
));
--> statement-breakpoint

-- ── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "support_tickets: self read" ON support_tickets;
--> statement-breakpoint
CREATE POLICY "support_tickets: self read" ON support_tickets
  FOR SELECT USING (deleted_at IS NULL AND user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "support_tickets: admin read" ON support_tickets;
--> statement-breakpoint
CREATE POLICY "support_tickets: admin read" ON support_tickets
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON support_tickets FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE support_threads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "support_threads: self read" ON support_threads;
--> statement-breakpoint
CREATE POLICY "support_threads: self read" ON support_threads
  FOR SELECT USING (deleted_at IS NULL AND user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "support_threads: admin read" ON support_threads;
--> statement-breakpoint
CREATE POLICY "support_threads: admin read" ON support_threads
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON support_threads FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "support_messages: self read" ON support_messages;
--> statement-breakpoint
CREATE POLICY "support_messages: self read" ON support_messages
  FOR SELECT USING (thread_id IN (SELECT id FROM support_threads WHERE user_id = auth_user_id() AND deleted_at IS NULL));
--> statement-breakpoint
DROP POLICY IF EXISTS "support_messages: admin read" ON support_messages;
--> statement-breakpoint
CREATE POLICY "support_messages: admin read" ON support_messages
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON support_messages FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE nudges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "nudges: parties read" ON nudges;
--> statement-breakpoint
CREATE POLICY "nudges: parties read" ON nudges
  FOR SELECT USING (from_user_id = auth_user_id() OR to_user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "nudges: admin read" ON nudges;
--> statement-breakpoint
CREATE POLICY "nudges: admin read" ON nudges
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON nudges FROM anon, authenticated;
