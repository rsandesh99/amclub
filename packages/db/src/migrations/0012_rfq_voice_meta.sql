-- Phase 8b — Voice RFQ. Original transcript + structured parse persisted on
-- the rfq row for quality review and future training signal. Written once at
-- RFQ creation by the server (admin client after auth checks); readable under
-- the rfqs row policies exactly like details. Idempotent: safe to re-run.
--
-- Shape (validated by @amclub/shared voiceMetaSchema before insert):
-- { transcript_english, parse: { category_slug, specialization, state,
--   description_english, original_language, uncertain },
--   duration_ms, edited_fields[], vendor: { stt, parser } }

ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS voice_meta jsonb;
