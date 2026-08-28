-- Phase 2 (pre-cutover) — terms acceptance capture + refund idempotency key.
-- Additive only.
--
-- 1. terms_acceptances — append-only record of WHICH document version a user
--    accepted, WHEN, and from WHERE. Same protections as quote_events: a
--    BEFORE UPDATE trigger raises, UPDATE/DELETE are revoked from client roles,
--    RLS = self-read + admin read, no UPDATE/DELETE policies. Written by the
--    service role from /api/v1/legal/accept.
-- 2. refunds.idempotency_key — deterministic per order so a crash between the
--    gateway refund and our row can never produce a second gateway refund.

-- ─── shared append-only guard ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION raise_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (no UPDATE)', TG_TABLE_NAME;
END;
$$;

-- ─── 1. terms_acceptances ───────────────────────────────────────────────────
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS terms_acceptances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc         text NOT NULL,
  version     text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  -- { ip, user_agent, locale, surface: 'web' | 'mobile' }
  payload     jsonb,
  CONSTRAINT terms_acceptances_doc_check CHECK (doc IN ('terms', 'privacy', 'provider_addendum'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS terms_acceptances_user_doc_idx ON terms_acceptances (user_id, doc);
--> statement-breakpoint
DROP TRIGGER IF EXISTS terms_acceptances_no_update ON terms_acceptances;
--> statement-breakpoint
CREATE TRIGGER terms_acceptances_no_update
  BEFORE UPDATE ON terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON terms_acceptances FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE terms_acceptances ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "terms_acceptances: self read" ON terms_acceptances;
--> statement-breakpoint
CREATE POLICY "terms_acceptances: self read" ON terms_acceptances
  FOR SELECT USING (user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "terms_acceptances: admin read" ON terms_acceptances;
--> statement-breakpoint
CREATE POLICY "terms_acceptances: admin read" ON terms_acceptances
  FOR SELECT USING (has_role('admin') OR has_role('ops'));

-- ─── 2. refunds.idempotency_key ─────────────────────────────────────────────
--> statement-breakpoint
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS idempotency_key text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS refunds_idempotency_key_uniq
  ON refunds (idempotency_key) WHERE idempotency_key IS NOT NULL;
