-- Audit wave 5, team D (operations): M35 cron heartbeat outcome + L7 hot-table indexes.
-- Always applied (not staged); every statement is idempotent, so a re-run is a no-op.
--
-- M35. cron_heartbeats (0014) only proved that a job ran: a payout run with failed transfers,
-- or an agent cron whose runtime refused the job, stayed green. Each beat now also stores the
-- run's OUTCOME, written by apps/web/lib/jobs/heartbeat.ts and rendered at /admin:
--   status   'ok'       the run finished and reported nothing wrong
--            'degraded' the run finished but reported failures (payouts failed / held /
--                       unconfirmed, refunds still failing, the runtime did not take the job, …)
--            'failed'   the run threw; last_ok_at keeps the last run that finished, updated_at
--                       says when it failed
--   summary  short and machine-readable: "payouts_failed=2 payouts_held=1" (degraded) or
--            "error: <message>" (failed); NULL when ok.
-- The table stays server-only: RLS on with no policy (0014), and now no client grant either
-- (Supabase's default privileges had granted ALL to anon / authenticated).
--
-- L7. Indexes for the hot, growing tables the performance advisor flagged:
--   notifications   polled every 30 s per open tab (unread count + the latest 50) — it had none
--   payments        order_id (every order page, paymentForOrder, reconcile)
--   checkout_sessions order_id (materialisation, bundles)
--   orders          quote_id (RFQ finalize, duplicate-order guard), package_id (FK)
--   quotes          (provider_id, created_at) — the provider's quote list
--   rfq_matches     (provider_id, notified_at) — the provider inbox (the PK leads with rfq_id)
--   payouts         (status, scheduled_for) — the daily payout batch
-- Plain CREATE INDEX, not CONCURRENTLY: CONCURRENTLY refuses to run inside a transaction block, and
-- migration tooling may apply a file as one. At current data sizes each build holds its lock for
-- milliseconds.
--
-- Backfill: none (existing heartbeats read 'ok' until their next run).
-- Rollback:
--   DROP INDEX IF EXISTS notifications_user_unread_idx, notifications_user_created_idx, payments_order_idx,
--     checkout_sessions_order_idx, orders_quote_idx, orders_package_idx, quotes_provider_created_idx,
--     rfq_matches_provider_notified_idx, payouts_status_scheduled_idx;
--   ALTER TABLE cron_heartbeats DROP CONSTRAINT IF EXISTS cron_heartbeats_status_check,
--     DROP CONSTRAINT IF EXISTS cron_heartbeats_summary_len, DROP COLUMN IF EXISTS summary, DROP COLUMN IF EXISTS status;
--   (The writer falls back to the 0014 columns when these are missing.)

-- ─── M35: heartbeat outcome ──────────────────────────────────────────────────
ALTER TABLE cron_heartbeats ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ok';
--> statement-breakpoint
ALTER TABLE cron_heartbeats ADD COLUMN IF NOT EXISTS summary text;
--> statement-breakpoint
ALTER TABLE cron_heartbeats DROP CONSTRAINT IF EXISTS cron_heartbeats_status_check;
--> statement-breakpoint
ALTER TABLE cron_heartbeats ADD CONSTRAINT cron_heartbeats_status_check CHECK (status IN ('ok', 'degraded', 'failed'));
--> statement-breakpoint
ALTER TABLE cron_heartbeats DROP CONSTRAINT IF EXISTS cron_heartbeats_summary_len;
--> statement-breakpoint
ALTER TABLE cron_heartbeats ADD CONSTRAINT cron_heartbeats_summary_len CHECK (summary IS NULL OR char_length(summary) <= 500);
--> statement-breakpoint
REVOKE ALL ON cron_heartbeats FROM anon, authenticated;
--> statement-breakpoint

-- ─── L7: hot-table indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications (user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payments_order_idx ON payments (order_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS checkout_sessions_order_idx ON checkout_sessions (order_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS orders_quote_idx ON orders (quote_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS orders_package_idx ON orders (package_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS quotes_provider_created_idx ON quotes (provider_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rfq_matches_provider_notified_idx ON rfq_matches (provider_id, notified_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payouts_status_scheduled_idx ON payouts (status, scheduled_for);
