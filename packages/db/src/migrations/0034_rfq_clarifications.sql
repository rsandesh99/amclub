-- RFQ clarification threads + quote revision (BUILD_PROMPTS S1.3) — additive,
-- idempotent, NOT staged (apply to prod before the writer deploys, RULES.md 2).
--
-- rfq_clarifications: one row per provider question on an active RFQ; the
-- buyer answers in place (answered_at IS NULL → open). Visible to the RFQ's
-- buyer and to EVERY matched provider of that RFQ (fairness; kills duplicate
-- questions). RLS is row-level only — the API never returns provider_id to a
-- provider, so no competitor learns who asked. Both free-text fields are
-- stored AFTER redactContactInfo with the *_redacted flag (§9.3). Soft delete
-- (deleted_at) per §2.5 rule 4 — user content is never hard-deleted.
-- "In clarification" is DERIVED (rfqIsActive + open questions), never an RFQ
-- status: rfqs.status, the 72-hour window and the expiry cron are untouched.
--
-- quotes.revision / revised_at: in-place revision of the provider's own
-- submitted quote (PATCH /api/v1/rfq/[id]/quote), optimistic-locked on
-- revision; revision counts submissions (1 = original, max 3). History lives in
-- quote_events ('revised', with before/after). quotes.status is not touched.

CREATE TABLE IF NOT EXISTS rfq_clarifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id             uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  provider_id        uuid NOT NULL REFERENCES provider_profiles(id),
  question           text NOT NULL CHECK (char_length(question) <= 500),
  question_redacted  boolean NOT NULL DEFAULT false,
  answer             text CHECK (answer IS NULL OR char_length(answer) <= 1000),
  answer_redacted    boolean NOT NULL DEFAULT false,
  asked_at           timestamptz NOT NULL DEFAULT now(),
  answered_at        timestamptz,
  answered_by        uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rfq_clarifications_rfq_asked_idx
  ON rfq_clarifications (rfq_id, asked_at);
--> statement-breakpoint
-- The cap query: open questions by one provider on one RFQ.
CREATE INDEX IF NOT EXISTS rfq_clarifications_open_by_provider_idx
  ON rfq_clarifications (rfq_id, provider_id) WHERE answered_at IS NULL AND deleted_at IS NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS rfq_clarifications_set_updated_at ON rfq_clarifications;
--> statement-breakpoint
CREATE TRIGGER rfq_clarifications_set_updated_at
  BEFORE UPDATE ON rfq_clarifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE rfq_clarifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "rfq_clarifications: buyer read own rfq" ON rfq_clarifications;
--> statement-breakpoint
CREATE POLICY "rfq_clarifications: buyer read own rfq" ON rfq_clarifications
  FOR SELECT USING (
    deleted_at IS NULL
    AND rfq_id IN (
      SELECT id FROM rfqs
      WHERE msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
    )
  );
--> statement-breakpoint
-- Every matched provider (declined or not) reads every question and answer on
-- the RFQ; is_provider_matched_to_rfq breaks the rfqs ↔ rfq_matches RLS cycle.
DROP POLICY IF EXISTS "rfq_clarifications: matched provider read" ON rfq_clarifications;
--> statement-breakpoint
CREATE POLICY "rfq_clarifications: matched provider read" ON rfq_clarifications
  FOR SELECT USING (deleted_at IS NULL AND is_provider_matched_to_rfq(rfq_id));
--> statement-breakpoint
DROP POLICY IF EXISTS "rfq_clarifications: admin all" ON rfq_clarifications;
--> statement-breakpoint
CREATE POLICY "rfq_clarifications: admin all" ON rfq_clarifications
  FOR ALL USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
-- No client writes: the routes insert/update with the service role after the party check.
REVOKE INSERT, UPDATE, DELETE ON rfq_clarifications FROM anon, authenticated;
--> statement-breakpoint

-- quotes: revision counter + timestamp (in-place PATCH; optimistic lock on revision).
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_revision_range;
--> statement-breakpoint
ALTER TABLE quotes ADD CONSTRAINT quotes_revision_range CHECK (revision >= 1 AND revision <= 3);
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS revised_at timestamptz;
--> statement-breakpoint
-- 0033 hid decline_note with a fixed column-list GRANT; the two new columns join
-- that list (column grants accumulate — idempotent). The staged Mart goods
-- columns stay in their own guarded block; nothing here names them.
GRANT SELECT (revision, revised_at) ON quotes TO anon, authenticated;
--> statement-breakpoint

-- quote_events: 'revised' joins the CHECK (full list restated, as 0029 did).
ALTER TABLE quote_events DROP CONSTRAINT IF EXISTS quote_events_event_type_check;
--> statement-breakpoint
ALTER TABLE quote_events ADD CONSTRAINT quote_events_event_type_check CHECK (
  event_type IN ('submitted', 'declined', 'withdrawn', 'accepted', 'expired', 'auto_declined', 'match_declined', 'revised')
);
