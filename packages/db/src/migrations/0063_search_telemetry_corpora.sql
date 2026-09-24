-- Experience v3 E15 (docs/prd/PRD_EXPERIENCE_V3.md FR-15.2 – FR-15.4; F4, F5, F6).
-- Nothing user-visible.
--
--   search_queries          F5: a sample of search result pages (normalised params
--                           + result count). NO user id. Kept 180 days (the nightly
--                           data-foundations cron purges). Service role only.
--   checkout_sessions.attribution / orders.attribution
--                           F5: { search_id, position } — the search that led to the
--                           order. Written best-effort AFTER the money writes
--                           (never part of the charge); readers tolerate absence.
--   users.corpus_consent_at F6: the explicit opt-in ("Help improve AMClub's Hindi and
--                           Telugu understanding"). NULL = off (the default).
--   corpus_voice_triples    F6: transcript → parsed requirement → the buyer's final
--                           request. TEXT ONLY — no audio is ever kept.
--   corpus_image_pairs      F6: a document-intake extraction → the final request, with
--                           the corrected keys; the image stays where it already is
--                           (the private rfq-attachments bucket), referenced by key.
--                           Both corpora: service role only; revoking consent deletes
--                           the user's rows (ON DELETE CASCADE on the user too).
--   service_synonyms        F6: curated term → category / service. Anyone reads REVIEWED
--                           rows (search uses only those); writes are service role.
--
-- Rollback: DROP TABLE service_synonyms, corpus_image_pairs, corpus_voice_triples,
-- search_queries; ALTER TABLE users DROP COLUMN corpus_consent_at; ALTER TABLE orders
-- DROP COLUMN attribution; ALTER TABLE checkout_sessions DROP COLUMN attribution;

CREATE TABLE IF NOT EXISTS search_queries (
  id            uuid PRIMARY KEY,
  query_norm    text CHECK (query_norm IS NULL OR char_length(query_norm) <= 120),
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_count  integer NOT NULL CHECK (result_count >= 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS search_queries_created_idx ON search_queries (created_at);
--> statement-breakpoint
ALTER TABLE search_queries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON search_queries FROM anon, authenticated;
--> statement-breakpoint

ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS attribution jsonb;
--> statement-breakpoint
ALTER TABLE orders ADD COLUMN IF NOT EXISTS attribution jsonb;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS corpus_consent_at timestamptz;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS corpus_voice_triples (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rfq_id      uuid,
  lang        text CHECK (lang IS NULL OR char_length(lang) <= 16),
  transcript  text NOT NULL CHECK (char_length(transcript) <= 4000),
  parsed      jsonb NOT NULL,
  final       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS corpus_voice_triples_user_idx ON corpus_voice_triples (user_id);
--> statement-breakpoint
ALTER TABLE corpus_voice_triples ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON corpus_voice_triples FROM anon, authenticated;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS corpus_image_pairs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rfq_id       uuid,
  storage_key  text CHECK (storage_key IS NULL OR char_length(storage_key) <= 400),
  doc_type     text,
  proposed     jsonb NOT NULL,
  final        jsonb NOT NULL,
  corrections  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS corpus_image_pairs_user_idx ON corpus_image_pairs (user_id);
--> statement-breakpoint
ALTER TABLE corpus_image_pairs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON corpus_image_pairs FROM anon, authenticated;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS service_synonyms (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term           text NOT NULL CHECK (char_length(term) BETWEEN 1 AND 80),
  term_key       text NOT NULL CHECK (char_length(term_key) BETWEEN 1 AND 80),
  lang           text NOT NULL CHECK (lang IN ('en', 'hi', 'te', 'ta', 'kn', 'mr', 'bn', 'gu', 'ml')),
  category_slug  text NOT NULL,
  service_slug   text,
  source         text NOT NULL CHECK (source IN ('curated', 'search_log', 'corpus')),
  reviewed       boolean NOT NULL DEFAULT false,
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_synonyms_term_lang_uniq UNIQUE (term_key, lang)
);
--> statement-breakpoint
ALTER TABLE service_synonyms ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON service_synonyms FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON service_synonyms TO anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "service_synonyms: read reviewed" ON service_synonyms;
--> statement-breakpoint
CREATE POLICY "service_synonyms: read reviewed" ON service_synonyms FOR SELECT USING (reviewed);
--> statement-breakpoint
DROP TRIGGER IF EXISTS service_synonyms_set_updated_at ON service_synonyms;
--> statement-breakpoint
CREATE TRIGGER service_synonyms_set_updated_at BEFORE UPDATE ON service_synonyms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
