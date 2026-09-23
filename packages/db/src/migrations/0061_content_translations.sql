-- Experience v3 E14 FR-14.3 (N32b, dark): a provider's own catalogue copy in
-- hi / te / ta. Gate: AGENT_ENABLED + agents_enabled.content_translate + cohort.
--
--   content_translations  model DRAFTS (provider_content_translate@v1), one open
--                         draft per (subject, field, lang). A draft never
--                         renders: only the provider's approve writes the text
--                         into the entity's i18n map (and one ai_decisions row,
--                         feature content_translation). The provider reads
--                         their own rows; only the service role writes.
--   packages.i18n_sources / provider_profiles.i18n_sources
--                         which i18n slots are approved machine translations
--                         ({"title": {"te": "machine_approved"}}) — the
--                         "Translated · View original" label reads it.
--   provider_profiles.about_i18n
--                         the About in hi / te / ta (English stays `about`).
--
-- Readers of the new columns tolerate their absence (a separate best-effort
-- query), so the code may ship before this migration is applied.
-- Rollback: DROP TABLE content_translations; ALTER TABLE packages DROP COLUMN
-- i18n_sources; ALTER TABLE provider_profiles DROP COLUMN about_i18n, DROP
-- COLUMN i18n_sources; restore the 0045 ai_decisions_feature_check.

CREATE TABLE IF NOT EXISTS content_translations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id    uuid NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  subject_kind   text NOT NULL CHECK (subject_kind IN ('package', 'profile')),
  subject_id     uuid NOT NULL,
  field          text NOT NULL CHECK (field IN ('title', 'ideal_for', 'about')),
  lang           text NOT NULL CHECK (lang IN ('hi', 'te', 'ta')),
  source_text    text NOT NULL CHECK (char_length(source_text) <= 1500),
  draft_text     text NOT NULL CHECK (char_length(draft_text) <= 1500),
  final_text     text CHECK (final_text IS NULL OR char_length(final_text) <= 1500),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected', 'stale')),
  invocation_id  uuid,
  decision_id    uuid,
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_translations_field_kind CHECK ((subject_kind = 'package' AND field IN ('title', 'ideal_for')) OR (subject_kind = 'profile' AND field = 'about'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS content_translations_one_draft ON content_translations (subject_kind, subject_id, field, lang) WHERE status = 'draft';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS content_translations_provider_idx ON content_translations (provider_id, created_at DESC);
--> statement-breakpoint
ALTER TABLE content_translations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON content_translations FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON content_translations TO authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "content_translations: provider read own" ON content_translations;
--> statement-breakpoint
CREATE POLICY "content_translations: provider read own" ON content_translations
  FOR SELECT USING (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));
--> statement-breakpoint
DROP TRIGGER IF EXISTS content_translations_set_updated_at ON content_translations;
--> statement-breakpoint
CREATE TRIGGER content_translations_set_updated_at BEFORE UPDATE ON content_translations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

ALTER TABLE packages ADD COLUMN IF NOT EXISTS i18n_sources jsonb;
--> statement-breakpoint
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS about_i18n jsonb;
--> statement-breakpoint
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS i18n_sources jsonb;
--> statement-breakpoint
-- Public like `about` (rls/policies.sql carries the same list; it is applied last).
GRANT SELECT (about_i18n, i18n_sources) ON provider_profiles TO anon, authenticated;
--> statement-breakpoint

ALTER TABLE ai_decisions DROP CONSTRAINT IF EXISTS ai_decisions_feature_check;
--> statement-breakpoint
ALTER TABLE ai_decisions ADD CONSTRAINT ai_decisions_feature_check CHECK (feature IN (
  'catalog_draft', 'payout_dossier', 'extraction_correction',
  'pool_draft', 'pool_card', 'documents_draft',
  'agent_tool', 'quote_extraction', 'decline_message', 'onboarding',
  'dispute_triage', 'rfq_quality', 'munshi_draft', 'support_reply', 'score_note',
  'rfq_intake', 'munshi_reply', 'support_nudge', 'procurement_step',
  'content_translation'
));
