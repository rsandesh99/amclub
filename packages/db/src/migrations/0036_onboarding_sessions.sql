-- Onboarding agent (BUILD_PROMPTS S1.6) — additive, idempotent, NOT staged
-- (apply to prod before the writer deploys, RULES.md 2).
--
-- onboarding_sessions: one durable row per WhatsApp (or web-started) provider
-- interview. The scripted state machine (ONBOARDING_STEPS in @amclub/shared)
-- lives in `state`; `answers` is the redacted transcript; the ONE model call
-- writes `draft` (+ draft_run_id); the provider's BUTTON tap is the
-- confirmation (draft_decision_id → ai_decisions, feature 'onboarding', tool
-- 'confirm_onboarding_draft'); the wizard's submit links provider_id. The
-- runtime never writes provider_profiles / provider_categories / packages /
-- provider_verifications — the wizard and its routes remain the only writers.
-- One ACTIVE session per user (partial unique index); expiry is sliding.
--
-- provider_capability_facts (ARCHITECTURE §10): confirmed capability facts
-- with provenance — written ONLY on draft confirmation, one per scope /
-- deliverable line, carrying the confirming ai_decisions row. No reader
-- before S2.2.
--
-- wa_conversations.active_session_id: the dispatcher's O(1) route from an
-- inbound message to its session; cleared on terminal states.
--
-- RLS: the user reads own rows, admin/ops read all, NO client writes (runtime
-- service role + the web routes). Mirrored in rls/policies.sql.

CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  root_run_id         uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  conversation_id     uuid REFERENCES wa_conversations(id) ON DELETE SET NULL,
  surface             text NOT NULL CHECK (surface IN ('whatsapp', 'web')),
  locale              text NOT NULL DEFAULT 'en',
  state               text NOT NULL DEFAULT 'language'
                      CHECK (state IN ('language', 'business_name', 'gstin', 'udyam', 'categories', 'capabilities', 'photos', 'drafting', 'review', 'confirmed', 'handed_off', 'abandoned', 'failed')),
  answers             jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- wa-media object paths (private bucket; signed URLs on read)
  photo_refs          text[] NOT NULL DEFAULT '{}',
  category_slugs      text[] NOT NULL DEFAULT '{}',
  gstin               text,
  udyam               text,
  draft               jsonb,
  draft_run_id        uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  draft_decision_id   uuid REFERENCES ai_decisions(id),
  -- model drafts produced so far (cap ONBOARDING_MAX_DRAFTS = 2)
  draft_count         integer NOT NULL DEFAULT 0,
  -- the provider tapped "Change something" and the next message is the revise note
  revise_pending      boolean NOT NULL DEFAULT false,
  confirmed_at        timestamptz,
  handed_off_at       timestamptz,
  -- set by the wizard submit when it consumed the draft (the ONLY draft → profile link)
  provider_id         uuid REFERENCES provider_profiles(id) ON DELETE SET NULL,
  last_prompt_at      timestamptz,
  expires_at          timestamptz NOT NULL,
  failure             text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
--> statement-breakpoint
-- One active session per user.
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_sessions_active_user_uniq
  ON onboarding_sessions (user_id) WHERE state NOT IN ('handed_off', 'abandoned', 'failed');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS onboarding_sessions_conversation_idx
  ON onboarding_sessions (conversation_id) WHERE conversation_id IS NOT NULL;
--> statement-breakpoint
-- The expiry job's query: active sessions past expires_at.
CREATE INDEX IF NOT EXISTS onboarding_sessions_expires_idx
  ON onboarding_sessions (expires_at) WHERE state NOT IN ('handed_off', 'abandoned', 'failed');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS onboarding_sessions_user_created_idx
  ON onboarding_sessions (user_id, created_at DESC);
--> statement-breakpoint
DROP TRIGGER IF EXISTS onboarding_sessions_set_updated_at ON onboarding_sessions;
--> statement-breakpoint
CREATE TRIGGER onboarding_sessions_set_updated_at
  BEFORE UPDATE ON onboarding_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE onboarding_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "onboarding_sessions: self read" ON onboarding_sessions;
--> statement-breakpoint
CREATE POLICY "onboarding_sessions: self read" ON onboarding_sessions
  FOR SELECT USING (deleted_at IS NULL AND user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "onboarding_sessions: admin read" ON onboarding_sessions;
--> statement-breakpoint
CREATE POLICY "onboarding_sessions: admin read" ON onboarding_sessions
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON onboarding_sessions FROM anon, authenticated;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS provider_capability_facts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id         uuid REFERENCES provider_profiles(id) ON DELETE SET NULL,
  category_slug       text NOT NULL,
  fact                text NOT NULL CHECK (char_length(fact) <= 300),
  locale              text NOT NULL,
  -- provenance: the confirmation that made this a fact
  source_decision_id  uuid NOT NULL REFERENCES ai_decisions(id),
  source_session_id   uuid REFERENCES onboarding_sessions(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS provider_capability_facts_user_idx
  ON provider_capability_facts (user_id, category_slug) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS provider_capability_facts_session_idx
  ON provider_capability_facts (source_session_id) WHERE source_session_id IS NOT NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS provider_capability_facts_set_updated_at ON provider_capability_facts;
--> statement-breakpoint
CREATE TRIGGER provider_capability_facts_set_updated_at
  BEFORE UPDATE ON provider_capability_facts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE provider_capability_facts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "provider_capability_facts: self read" ON provider_capability_facts;
--> statement-breakpoint
CREATE POLICY "provider_capability_facts: self read" ON provider_capability_facts
  FOR SELECT USING (deleted_at IS NULL AND user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "provider_capability_facts: admin read" ON provider_capability_facts;
--> statement-breakpoint
CREATE POLICY "provider_capability_facts: admin read" ON provider_capability_facts
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON provider_capability_facts FROM anon, authenticated;
--> statement-breakpoint

-- The dispatcher's O(1) lookup from a conversation to its active session.
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS active_session_id uuid REFERENCES onboarding_sessions(id) ON DELETE SET NULL;
