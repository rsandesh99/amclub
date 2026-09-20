-- Trust mechanics (BUILD_PROMPTS S0.4) — additive, idempotent, NOT staged
-- (apply to prod before/with the writer, RULES.md 2).
--
-- 1. rfq_matches: quote-or-decline. declined_at + decline_reason make a
--    provider decline an ACTIVE decision; the rfq-expire cron sets
--    reason 'window_lapsed' when the quote window passes with no action.
-- 2. quote_events: CHECK widened with 'match_declined' for forward-compat.
--    NOTE: quote_id is NOT NULL, so a declined MATCH (no quote row) is NOT
--    recorded here — rfq_matches.declined_at is the source of truth
--    (docs/FOLLOWUPS.md — Agent S0.4).
-- 3. udyam_verifications: mirrors gstin_verifications (0021) — every attempt
--    recorded; stub never counts as verified; self + admin read, service writes.
-- 4. provider_profiles.udyam_verified (msme_profiles already has it, 0000).
-- 5. provider_score_inputs_v1: `ignored` excludes declined matches and two new
--    columns are APPENDED (additive; existing columns + order byte-identical).

-- ─── 1. rfq_matches decline ──────────────────────────────────────────────────
ALTER TABLE rfq_matches ADD COLUMN IF NOT EXISTS declined_at timestamptz;
--> statement-breakpoint
ALTER TABLE rfq_matches ADD COLUMN IF NOT EXISTS decline_reason text;
--> statement-breakpoint
ALTER TABLE rfq_matches DROP CONSTRAINT IF EXISTS rfq_matches_decline_reason_check;
--> statement-breakpoint
ALTER TABLE rfq_matches ADD CONSTRAINT rfq_matches_decline_reason_check
  CHECK (decline_reason IS NULL OR decline_reason IN ('not_my_specialty', 'capacity', 'location', 'budget', 'other', 'window_lapsed'));
--> statement-breakpoint
-- Cron sweep: open matches with no decline, by notification time.
CREATE INDEX IF NOT EXISTS rfq_matches_open_notified_idx
  ON rfq_matches (notified_at) WHERE declined_at IS NULL;
--> statement-breakpoint

-- ─── 2. quote_events CHECK (forward-compat) ──────────────────────────────────
ALTER TABLE quote_events DROP CONSTRAINT IF EXISTS quote_events_event_type_check;
--> statement-breakpoint
ALTER TABLE quote_events ADD CONSTRAINT quote_events_event_type_check CHECK (
  event_type IN ('submitted', 'declined', 'withdrawn', 'accepted', 'expired', 'auto_declined', 'match_declined')
);
--> statement-breakpoint

-- ─── 3. udyam_verifications (mirror of gstin_verifications) ──────────────────
CREATE TABLE IF NOT EXISTS udyam_verifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  udyam_number text NOT NULL,
  verified     boolean NOT NULL,
  -- true when the dev stub answered (no KYC_API_KEY) — never counts as verified
  stub         boolean NOT NULL DEFAULT false,
  -- 'surepass' | 'stub' | 'admin_attest'
  provider     text NOT NULL,
  result       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS udyam_verifications_lookup_idx
  ON udyam_verifications (user_id, udyam_number, created_at DESC);
--> statement-breakpoint
ALTER TABLE udyam_verifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "udyam_verifications: self read" ON udyam_verifications;
--> statement-breakpoint
CREATE POLICY "udyam_verifications: self read" ON udyam_verifications
  FOR SELECT USING (user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "udyam_verifications: admin read" ON udyam_verifications;
--> statement-breakpoint
CREATE POLICY "udyam_verifications: admin read" ON udyam_verifications
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON udyam_verifications FROM anon, authenticated;
--> statement-breakpoint

-- ─── 4. provider_profiles.udyam_verified ─────────────────────────────────────
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS udyam_verified boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- ─── 5. provider_score_inputs_v1 — declined matches are decisions, not silence ─
-- Full restatement of the 0020 view: `ignored` gains AND m.declined_at IS NULL;
-- a `declined` CTE + two columns are APPENDED at the end. All else untouched.
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
  -- Matched to an RFQ that expired without this provider ever quoting AND
  -- without declining (S0.4: a decline is a decision, not silence).
  SELECT m.provider_id, count(*)::int AS rfqs_matched_never_quoted
  FROM rfq_matches m
  JOIN rfqs r ON r.id = m.rfq_id
  WHERE r.status = 'expired'
    AND m.declined_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM quotes q WHERE q.rfq_id = m.rfq_id AND q.provider_id = m.provider_id
    )
  GROUP BY m.provider_id
),
declined AS (
  SELECT m.provider_id,
         count(*)::int AS rfqs_matched_declined,
         count(*) FILTER (WHERE m.decline_reason = 'window_lapsed')::int AS rfqs_window_lapsed
  FROM rfq_matches m
  WHERE m.declined_at IS NOT NULL
  GROUP BY m.provider_id
),
deliv AS (
  SELECT o.provider_id, o.id AS order_id, o.due_at, min(e.created_at) AS first_delivered_at
  FROM orders o
  JOIN order_events e ON e.order_id = o.id AND e.event = 'deliver'
  WHERE o.deleted_at IS NULL
    AND o.kind = 'service'
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
    AND o.kind = 'service'
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
  WHERE o.kind = 'service'
  GROUP BY o.provider_id
)
SELECT
  p.id                                              AS provider_id,
  r.median_response_hours,
  r.median_view_hours,
  COALESCE(r.response_sample_count, 0)              AS response_sample_count,
  COALESCE(qe.quotes_submitted, 0)                  AS quotes_submitted,
  COALESCE(qe.quotes_accepted, 0)                   AS quotes_accepted,
  COALESCE(qe.quotes_withdrawn, 0)                  AS quotes_withdrawn,
  COALESCE(qe.quotes_declined, 0)                   AS quotes_declined,
  COALESCE(qe.quotes_auto_declined, 0)              AS quotes_auto_declined,
  COALESCE(qe.quotes_expired_silent, 0)             AS quotes_expired_silent,
  COALESCE(ig.rfqs_matched_never_quoted, 0)         AS rfqs_matched_never_quoted,
  COALESCE(dl.delivered_orders, 0)                  AS delivered_orders,
  COALESCE(dl.on_time_deliveries, 0)                AS on_time_deliveries,
  CASE WHEN COALESCE(dl.delivered_orders, 0) > 0
       THEN dl.on_time_deliveries::numeric / dl.delivered_orders
       ELSE NULL END                                AS on_time_delivery_rate,
  COALESCE(o.completed_orders, 0)                   AS completed_orders,
  COALESCE(o.confirmed_by_buyer_count, 0)           AS confirmed_by_buyer_count,
  COALESCE(o.auto_accepted_count, 0)                AS auto_accepted_count,
  COALESCE(d.disputes_total, 0)                     AS disputes_total,
  COALESCE(d.disputes_at_fault, 0)                  AS disputes_at_fault,
  COALESCE(d.disputes_in_favour, 0)                 AS disputes_in_favour,
  -- S0.4 (appended): active declines, and how many were the cron's window lapse
  COALESCE(dc.rfqs_matched_declined, 0)             AS rfqs_matched_declined,
  COALESCE(dc.rfqs_window_lapsed, 0)                AS rfqs_window_lapsed
FROM provider_profiles p
LEFT JOIN resp_agg  r  ON r.provider_id  = p.id
LEFT JOIN qe           ON qe.provider_id = p.id
LEFT JOIN ignored   ig ON ig.provider_id = p.id
LEFT JOIN declined  dc ON dc.provider_id = p.id
LEFT JOIN deliv_agg dl ON dl.provider_id = p.id
LEFT JOIN ord       o  ON o.provider_id  = p.id
LEFT JOIN disp      d  ON d.provider_id  = p.id
WHERE p.deleted_at IS NULL;
--> statement-breakpoint
REVOKE ALL ON provider_score_inputs_v1 FROM anon, authenticated;
