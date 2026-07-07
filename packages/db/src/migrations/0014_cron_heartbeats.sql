-- STATUS_AUDIT B3/#5 — make dead crons visible. Each Vercel cron upserts a
-- heartbeat row on every successful run; the admin dashboard flags rows whose
-- last_ok_at is older than the schedule. RLS enabled with NO policies —
-- service-role writes, admin UI reads via service role. Idempotent.

CREATE TABLE IF NOT EXISTS cron_heartbeats (
  name        text PRIMARY KEY,          -- 'auto-cancel' | 'auto-accept' | 'rfq-expire' | 'reconcile' | 'payouts'
  last_ok_at  timestamptz NOT NULL,
  last_result jsonb,                     -- the route's summary payload (counts)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz
);

ALTER TABLE cron_heartbeats ENABLE ROW LEVEL SECURITY;
