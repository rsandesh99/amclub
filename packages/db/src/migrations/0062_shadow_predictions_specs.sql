-- Experience v3 E15 (docs/prd/PRD_EXPERIENCE_V3.md FR-15.1, FR-15.5 — F3, F10).
-- Nothing user-visible.
--
--   rfqs.cad_features     typed CAD features (bounding box, hole estimate, entity
--                         counts) written at RFQ create from the deterministic
--                         STEP / DXF parse (shared drawings/) — never a model.
--   shadow_predictions    predicted vs actual for a shadow feature (rules first):
--                         subject ids only, no personal data, kept 24 months.
--                         SERVICE ROLE ONLY — no client grant, no policy.
--                         Writers: apps/web/lib/shadow (recordShadow / resolveShadow).
--
-- Rollback: DROP TABLE shadow_predictions; ALTER TABLE rfqs DROP COLUMN cad_features;

ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS cad_features jsonb;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS shadow_predictions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature        text NOT NULL CHECK (feature IN ('cad_price_band', 'provider_fit')),
  model_version  text NOT NULL CHECK (char_length(model_version) <= 60),
  subject_kind   text NOT NULL CHECK (subject_kind IN ('rfq')),
  subject_id     uuid NOT NULL,
  predicted      jsonb NOT NULL,
  actual         jsonb,
  error          numeric,
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS shadow_predictions_subject_idx ON shadow_predictions (feature, subject_kind, subject_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS shadow_predictions_created_idx ON shadow_predictions (feature, created_at DESC);
--> statement-breakpoint
ALTER TABLE shadow_predictions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON shadow_predictions FROM anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS shadow_predictions_set_updated_at ON shadow_predictions;
--> statement-breakpoint
CREATE TRIGGER shadow_predictions_set_updated_at BEFORE UPDATE ON shadow_predictions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
