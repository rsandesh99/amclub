-- Phase S2.1 — additive `kind` discriminator on orders + checkout_sessions,
-- and kind-scoping of the services trust view (Mart pre-land; audit 1a/6a).
--
-- Ordering-critical: this lands BEFORE any goods row can exist, so the
-- "goods orders contaminate services trust stats" failure mode is impossible.
-- Byte-identity: every existing row defaults to kind='service', so the score
-- view output is IDENTICAL before/after (fixture-proven), and order_safe_view
-- gains exactly one column (+ kind) with every pre-existing column unchanged.
-- No writer ships with this migration by design: kind is written only by
-- future flag-gated Mart code; both INSERT paths use named column lists, so
-- the default covers services (checkout route upsert; materialize_order 0003).

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'service'
    CHECK (kind IN ('service', 'goods'));
--> statement-breakpoint
ALTER TABLE checkout_sessions
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'service'
    CHECK (kind IN ('service', 'goods'));
--> statement-breakpoint

-- ─── order_safe_view rebuild ─────────────────────────────────────────────────
-- Copied VERBATIM from rls/policies.sql (which re-creates the same view on
-- bootstrap, after this migration). The view is `o.*`, so the new column
-- requires DROP + CREATE (42P16 otherwise — Phase 8 restore-drill lesson).
DROP VIEW IF EXISTS order_safe_view;
--> statement-breakpoint
CREATE VIEW order_safe_view AS
  SELECT
    o.*,
    CASE
      WHEN o.status = 'placed'
        AND o.provider_id IN (
          SELECT id FROM provider_profiles WHERE user_id = auth.uid()
        )
      THEN NULL
      ELSE (
        SELECT u.phone FROM users u
        JOIN msme_profiles mp ON mp.user_id = u.id
        WHERE mp.id = o.msme_id
      )
    END AS msme_phone
  FROM orders o;
--> statement-breakpoint

-- ─── provider_score_inputs_v1: scope order CTEs to kind='service' ───────────
-- Full restatement of the 0016 view with EXACTLY three added predicates
-- (deliv, ord, disp CTEs). The quote-side CTEs (resp/resp_agg/qe/ignored) are
-- byte-untouched. disp keeps its current shape (no deleted_at filter) — scope,
-- never repair. Output is byte-identical while every order is kind='service'.
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
-- Re-assert grants (CREATE OR REPLACE preserves them, but keep this idempotent
-- and self-contained, matching 0016's closing block).
REVOKE ALL ON provider_score_inputs_v1 FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON provider_score_inputs_v1 TO authenticated;
