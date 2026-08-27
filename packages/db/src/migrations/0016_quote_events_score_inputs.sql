-- Phase 1 (pre-cutover) — durable event capture for the provider score.
-- Additive only: new tables, one view, no changes to existing columns.
--
-- 1. quote_events — append-only lifecycle history for quotes (mirrors
--    order_events). Written by the service role at every quotes.status
--    mutation; the status column itself is untouched.
-- 2. bank_account_verifications — server-side record of /kyc/verify-bank
--    results so provider onboarding no longer trusts a client-sent flag.
-- 3. provider_score_inputs_v1 — read-only per-provider inputs (no score).

-- ─── 1. quote_events ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS quote_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id    uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  -- submitted | declined | withdrawn | accepted | expired | auto_declined
  event_type  text NOT NULL,
  -- acting user id, or the literal 'system' for cron/payment-driven events
  actor       text NOT NULL DEFAULT 'system',
  reason      text,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_events_event_type_check CHECK (
    event_type IN ('submitted', 'declined', 'withdrawn', 'accepted', 'expired', 'auto_declined')
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS quote_events_quote_idx ON quote_events (quote_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS quote_events_type_idx ON quote_events (event_type);
--> statement-breakpoint
-- Append-only at the database level: no role may UPDATE a row (trigger), and
-- client roles may not UPDATE/DELETE (grants + no RLS policy). DELETE is left
-- possible for the service role only, via the quotes FK cascade — needed for
-- data-erasure and test cleanup; never called from app code.
CREATE OR REPLACE FUNCTION quote_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'quote_events is append-only (no UPDATE)';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS quote_events_no_update ON quote_events;
--> statement-breakpoint
CREATE TRIGGER quote_events_no_update
  BEFORE UPDATE ON quote_events
  FOR EACH ROW EXECUTE FUNCTION quote_events_append_only();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON quote_events FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE quote_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "quote_events: provider read own" ON quote_events;
--> statement-breakpoint
CREATE POLICY "quote_events: provider read own" ON quote_events
  FOR SELECT USING (
    quote_id IN (
      SELECT id FROM quotes
      WHERE provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "quote_events: msme read own rfq" ON quote_events;
--> statement-breakpoint
CREATE POLICY "quote_events: msme read own rfq" ON quote_events
  FOR SELECT USING (
    quote_id IN (
      SELECT q.id FROM quotes q
      JOIN rfqs r ON r.id = q.rfq_id
      WHERE r.msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "quote_events: admin read" ON quote_events;
--> statement-breakpoint
CREATE POLICY "quote_events: admin read" ON quote_events
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
DROP POLICY IF EXISTS "quote_events: admin insert" ON quote_events;
--> statement-breakpoint
CREATE POLICY "quote_events: admin insert" ON quote_events
  FOR INSERT WITH CHECK (has_role('admin') OR has_role('ops'));

-- ─── 2. bank_account_verifications ──────────────────────────────────────────
-- One row per /kyc/verify-bank call. The account number is never stored here —
-- only a keyed fingerprint (HMAC of account|IFSC) that onboarding matches
-- against. RLS enabled with NO policies: service-role only.
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS bank_account_verifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL,
  account_fingerprint text NOT NULL,
  ifsc                text NOT NULL,
  account_holder      text NOT NULL,
  verified            boolean NOT NULL,
  -- true when the dev stub answered (no KYC_API_KEY) — never counts as verified
  stub                boolean NOT NULL DEFAULT false,
  -- 'surepass' | 'stub'
  provider            text NOT NULL,
  result              jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bank_account_verifications_lookup_idx
  ON bank_account_verifications (user_id, account_fingerprint, created_at DESC);
--> statement-breakpoint
ALTER TABLE bank_account_verifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON bank_account_verifications FROM anon, authenticated;

-- ─── 3. provider_score_inputs_v1 ────────────────────────────────────────────
-- Read-only inputs, one row per provider. NO score is computed here.
-- security_invoker: the caller's RLS applies to every underlying table, so a
-- provider sees only their own inputs; admins/service role see all.
--
-- Response clock: rfq_matches.notified_at → quotes.created_at (primary) and
-- notified_at → viewed_at (secondary). rfq.created_at is deliberately NOT used.
-- "On-time" is first delivery (order_events.deliver) on/before orders.due_at —
-- order_milestones is unused by the app, so delivery is the only milestone.
--> statement-breakpoint
CREATE OR REPLACE VIEW provider_score_inputs_v1
WITH (security_invoker = true) AS
WITH resp AS (
  SELECT q.provider_id,
         EXTRACT(EPOCH FROM (q.created_at - m.notified_at)) / 3600.0 AS hours_to_quote,
         EXTRACT(EPOCH FROM (m.viewed_at  - m.notified_at)) / 3600.0 AS hours_to_view
  FROM quotes q
  JOIN rfq_matches m ON m.rfq_id = q.rfq_id AND m.provider_id = q.provider_id
),
resp_agg AS (
  SELECT provider_id,
         count(*)::int AS response_sample_count,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY hours_to_quote) AS median_response_hours,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY hours_to_view)
           FILTER (WHERE hours_to_view IS NOT NULL) AS median_view_hours
  FROM resp
  GROUP BY provider_id
),
qe AS (
  SELECT q.provider_id,
         count(*) FILTER (WHERE e.event_type = 'submitted')::int     AS quotes_submitted,
         count(*) FILTER (WHERE e.event_type = 'accepted')::int      AS quotes_accepted,
         count(*) FILTER (WHERE e.event_type = 'withdrawn')::int     AS quotes_withdrawn,
         count(*) FILTER (WHERE e.event_type = 'declined')::int      AS quotes_declined,
         count(*) FILTER (WHERE e.event_type = 'auto_declined')::int AS quotes_auto_declined,
         count(*) FILTER (WHERE e.event_type = 'expired')::int       AS quotes_expired_silent
  FROM quote_events e
  JOIN quotes q ON q.id = e.quote_id
  GROUP BY q.provider_id
),
ignored AS (
  -- Matched to an RFQ that expired without this provider ever quoting.
  SELECT m.provider_id, count(*)::int AS rfqs_matched_never_quoted
  FROM rfq_matches m
  JOIN rfqs r ON r.id = m.rfq_id
  WHERE r.status = 'expired'
    AND NOT EXISTS (
      SELECT 1 FROM quotes q WHERE q.rfq_id = m.rfq_id AND q.provider_id = m.provider_id
    )
  GROUP BY m.provider_id
),
deliv AS (
  SELECT o.provider_id, o.id AS order_id, o.due_at, min(e.created_at) AS first_delivered_at
  FROM orders o
  JOIN order_events e ON e.order_id = o.id AND e.event = 'deliver'
  WHERE o.deleted_at IS NULL
  GROUP BY o.provider_id, o.id, o.due_at
),
deliv_agg AS (
  SELECT provider_id,
         count(*)::int AS delivered_orders,
         count(*) FILTER (WHERE due_at IS NULL OR first_delivered_at <= due_at)::int AS on_time_deliveries
  FROM deliv
  GROUP BY provider_id
),
ord AS (
  SELECT o.provider_id,
         count(*) FILTER (WHERE o.status IN ('completed', 'reviewed'))::int AS completed_orders,
         count(*) FILTER (
           WHERE o.status IN ('completed', 'reviewed')
             AND EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.event = 'accept_delivery')
         )::int AS confirmed_by_buyer_count,
         count(*) FILTER (
           WHERE o.status IN ('completed', 'reviewed')
             AND EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.event = 'auto_accepted')
         )::int AS auto_accepted_count
  FROM orders o
  WHERE o.deleted_at IS NULL
  GROUP BY o.provider_id
),
disp AS (
  SELECT o.provider_id,
         count(*)::int AS disputes_total,
         count(*) FILTER (
           WHERE d.status = 'resolved' AND d.resolution IN ('refund_full', 'refund_partial')
         )::int AS disputes_at_fault,
         count(*) FILTER (WHERE d.status = 'resolved' AND d.resolution = 'release')::int AS disputes_in_favour
  FROM disputes d
  JOIN orders o ON o.id = d.order_id
  GROUP BY o.provider_id
)
SELECT
  p.id                                              AS provider_id,
  -- response time (hours; NULL until the provider has quoted at least once)
  r.median_response_hours,
  r.median_view_hours,
  COALESCE(r.response_sample_count, 0)              AS response_sample_count,
  -- quote discipline: active decisions vs silence
  COALESCE(qe.quotes_submitted, 0)                  AS quotes_submitted,
  COALESCE(qe.quotes_accepted, 0)                   AS quotes_accepted,
  COALESCE(qe.quotes_withdrawn, 0)                  AS quotes_withdrawn,
  COALESCE(qe.quotes_declined, 0)                   AS quotes_declined,
  COALESCE(qe.quotes_auto_declined, 0)              AS quotes_auto_declined,
  COALESCE(qe.quotes_expired_silent, 0)             AS quotes_expired_silent,
  COALESCE(ig.rfqs_matched_never_quoted, 0)         AS rfqs_matched_never_quoted,
  -- delivery
  COALESCE(dl.delivered_orders, 0)                  AS delivered_orders,
  COALESCE(dl.on_time_deliveries, 0)                AS on_time_deliveries,
  CASE WHEN COALESCE(dl.delivered_orders, 0) > 0
       THEN dl.on_time_deliveries::numeric / dl.delivered_orders
       ELSE NULL END                                AS on_time_delivery_rate,
  -- completion
  COALESCE(o.completed_orders, 0)                   AS completed_orders,
  COALESCE(o.confirmed_by_buyer_count, 0)           AS confirmed_by_buyer_count,
  COALESCE(o.auto_accepted_count, 0)                AS auto_accepted_count,
  -- disputes
  COALESCE(d.disputes_total, 0)                     AS disputes_total,
  COALESCE(d.disputes_at_fault, 0)                  AS disputes_at_fault,
  COALESCE(d.disputes_in_favour, 0)                 AS disputes_in_favour
FROM provider_profiles p
LEFT JOIN resp_agg  r  ON r.provider_id  = p.id
LEFT JOIN qe           ON qe.provider_id = p.id
LEFT JOIN ignored   ig ON ig.provider_id = p.id
LEFT JOIN deliv_agg dl ON dl.provider_id = p.id
LEFT JOIN ord       o  ON o.provider_id  = p.id
LEFT JOIN disp      d  ON d.provider_id  = p.id
WHERE p.deleted_at IS NULL;
--> statement-breakpoint
-- Supabase default privileges grant client roles ALL on new objects; a view
-- must be read-only for them (security_invoker still applies each table's RLS).
REVOKE ALL ON provider_score_inputs_v1 FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON provider_score_inputs_v1 TO authenticated;
