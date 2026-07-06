-- Phase 8b v1.1 amendment — AI cost observability. One row per model call
-- (voice STT, requirement parse), written server-side (service role) from
-- lib/voice; RLS enabled with NO policies so clients can never read/write it.
-- Append-only telemetry like audit_logs. cost_est_paise is an ESTIMATE in
-- paise (env-driven rates; exact vendor usage kept raw in meta). Idempotent.

CREATE TABLE IF NOT EXISTS ai_invocations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  feature       text NOT NULL,             -- 'voice_rfq'
  step          text NOT NULL,             -- 'stt' | 'parse'
  vendor        text NOT NULL,             -- 'sarvam:saaras:v3' | 'openrouter:<model>' | 'stub'
  status        text NOT NULL,             -- 'ok' | 'error' | 'stub'
  latency_ms    integer NOT NULL,
  cost_est_paise bigint,                   -- estimated vendor cost (INR paise); null = unknown
  input_bytes   integer,                   -- audio bytes (stt) / prompt chars (parse)
  output_chars  integer,
  request_id    text,                      -- vendor-side request id when returned
  error         text,
  meta          jsonb,                     -- raw usage (tokens, vendor cost fields)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_invocations_feature_created_idx
  ON ai_invocations (feature, created_at);
CREATE INDEX IF NOT EXISTS ai_invocations_status_created_idx
  ON ai_invocations (status, created_at);

ALTER TABLE ai_invocations ENABLE ROW LEVEL SECURITY;
