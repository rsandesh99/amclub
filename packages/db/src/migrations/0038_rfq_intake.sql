-- Voice RFQ v2 / document intake (BUILD_PROMPTS S1.8) — additive, idempotent,
-- NOT staged (apply to prod before the writer deploys, RULES.md 2).
--
-- rfq_intake_extractions (agent-owned): one row per intake result the buyer
-- was shown — the ONE clarifying question ('clarify'), a photo / text-PDF
-- extraction ('document'), or a deterministic STEP / DXF summary ('drawing',
-- model NULL: no model is ever called for a drawing). input_refs are references
-- only (attachment path, mime, audio duration); proposed is the schema-
-- validated result. Nothing here creates an RFQ: the buyer's Create tap on
-- POST /api/v1/rfq links the rows (rfq_id) and writes ONE ai_decisions row
-- (feature rfq_intake) whose id lands in decision_id. A linked row can never be
-- reused (the route refuses ids that already carry an rfq_id).
--
-- ai_decisions_feature_check restated with 'rfq_intake' (the 0027 list).
-- RLS: user reads own; admin/ops read all; no client writes.

CREATE TABLE IF NOT EXISTS rfq_intake_extractions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  kind             text NOT NULL CHECK (kind IN ('clarify', 'document', 'drawing')),
  -- { attachment_path?, mime?, name?, audio_duration_ms?, transcript_chars?, gap? } — refs, never content
  input_refs       jsonb NOT NULL,
  -- clarifyQuestionSchema | documentExtractSchema | drawingSummarySchema (validated)
  proposed         jsonb NOT NULL,
  model            text,
  stub             boolean NOT NULL DEFAULT false,
  cost_est_paise   bigint,
  rfq_id           uuid REFERENCES rfqs(id),
  decision_id      uuid REFERENCES ai_decisions(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rfq_intake_extractions_user_created_idx ON rfq_intake_extractions (user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rfq_intake_extractions_rfq_idx ON rfq_intake_extractions (rfq_id) WHERE rfq_id IS NOT NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS rfq_intake_extractions_set_updated_at ON rfq_intake_extractions;
--> statement-breakpoint
CREATE TRIGGER rfq_intake_extractions_set_updated_at
  BEFORE UPDATE ON rfq_intake_extractions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE rfq_intake_extractions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "rfq_intake_extractions: own read" ON rfq_intake_extractions;
--> statement-breakpoint
CREATE POLICY "rfq_intake_extractions: own read" ON rfq_intake_extractions
  FOR SELECT USING (deleted_at IS NULL AND user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "rfq_intake_extractions: admin read" ON rfq_intake_extractions;
--> statement-breakpoint
CREATE POLICY "rfq_intake_extractions: admin read" ON rfq_intake_extractions
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON rfq_intake_extractions FROM anon, authenticated;
--> statement-breakpoint
-- The ai_decisions feature CHECK, restated in full: the 0027 list + 'rfq_intake' (S1.8).
ALTER TABLE ai_decisions DROP CONSTRAINT IF EXISTS ai_decisions_feature_check;
--> statement-breakpoint
ALTER TABLE ai_decisions ADD CONSTRAINT ai_decisions_feature_check CHECK (feature IN (
  'catalog_draft', 'payout_dossier', 'extraction_correction',
  'pool_draft', 'pool_card', 'documents_draft',
  'agent_tool', 'quote_extraction', 'decline_message', 'onboarding',
  'dispute_triage', 'rfq_quality', 'munshi_draft', 'support_reply', 'score_note',
  'rfq_intake'
));
