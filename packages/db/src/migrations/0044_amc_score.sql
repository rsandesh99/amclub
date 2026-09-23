-- AMC Score v1 (BUILD_PROMPTS S2.4, ADR-010) — additive, idempotent, NOT staged
-- (apply to prod before the writer deploys, RULES.md 2).
--
-- score_inputs_provider(p_since) / score_inputs_buyer(p_since): SECURITY INVOKER
-- SQL functions returning ONE row per subject with the raw counts the v1 formula
-- (packages/shared/src/score.ts) needs, restricted to events after p_since and to
-- SERVICES (orders.kind = 'service'; RFQs with a category_id; service checkout
-- sessions). EXECUTE for service_role only. provider_score_inputs_v1 and
-- cron/provider-stats are untouched.
--
-- provider_scores / buyer_scores: the latest snapshot per (subject, version),
-- upserted nightly by cron/score-compute. score_history: one row per subject per
-- day (trends; insert-once). score_events: APPEND-ONLY (RULES 3) — a row only when
-- a score moves by ≥ 1, with the component that moved most.
--
-- RLS: a provider reads their OWN provider rows (the card's switch is enforced in
-- the route); buyer rows are admin / ops only (not even the buyer, v1); no client
-- writes anywhere. munshi_provider_state gains last_growth_at (the weekly nudge).

-- ─── 1. inputs: provider ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION score_inputs_provider(p_since timestamptz)
RETURNS TABLE (
  provider_id                  uuid,
  response_samples             integer,
  median_response_hours        double precision,
  delivered_orders             integer,
  on_time_deliveries           integer,
  completed_orders             integer,
  confirmed_by_buyer           integer,
  auto_accepted                integer,
  closed_orders                integer,
  disputes_at_fault            integer,
  matches_decided_or_closed    integer,
  matches_quoted               integer,
  matches_declined_with_reason integer
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
  WITH resp AS (
    -- notified → quoted, for quotes made in the window on a services RFQ
    SELECT q.provider_id,
           GREATEST(0, EXTRACT(EPOCH FROM (q.created_at - m.notified_at)) / 3600.0) AS h
    FROM quotes q
    JOIN rfq_matches m ON m.rfq_id = q.rfq_id AND m.provider_id = q.provider_id
    JOIN rfqs r ON r.id = q.rfq_id
    WHERE q.created_at >= p_since AND m.notified_at IS NOT NULL AND r.category_id IS NOT NULL
  ),
  resp_agg AS (
    SELECT provider_id, count(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY h) AS med
    FROM resp GROUP BY provider_id
  ),
  deliv AS (
    SELECT o.provider_id, o.due_at, min(e.created_at) AS first_at
    FROM orders o
    JOIN order_events e ON e.order_id = o.id AND e.event = 'deliver'
    WHERE o.deleted_at IS NULL AND o.kind = 'service'
    GROUP BY o.provider_id, o.id, o.due_at
  ),
  deliv_agg AS (
    SELECT provider_id,
           count(*)::int AS delivered,
           count(*) FILTER (WHERE due_at IS NULL OR first_at <= due_at)::int AS on_time
    FROM deliv WHERE first_at >= p_since GROUP BY provider_id
  ),
  ord AS (
    SELECT o.provider_id,
           count(*)::int AS completed,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.event = 'accept_delivery'))::int AS confirmed,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.event = 'auto_accepted'))::int AS auto_acc
    FROM orders o
    WHERE o.deleted_at IS NULL AND o.kind = 'service'
      AND o.status IN ('completed', 'reviewed') AND o.completed_at >= p_since
    GROUP BY o.provider_id
  ),
  res AS (
    -- disputes resolved in the window; a resolved_* order is a CLOSED order too
    SELECT o.provider_id,
           count(DISTINCT o.id) FILTER (WHERE o.status IN ('resolved_refund', 'resolved_release', 'resolved_partial'))::int AS resolved_closed,
           count(*) FILTER (WHERE d.resolution IN ('refund_full', 'refund_partial'))::int AS at_fault
    FROM disputes d
    JOIN orders o ON o.id = d.order_id
    WHERE o.deleted_at IS NULL AND o.kind = 'service'
      AND d.status = 'resolved' AND d.resolved_at >= p_since
    GROUP BY o.provider_id
  ),
  mt AS (
    SELECT x.provider_id,
           count(*) FILTER (WHERE x.quoted OR x.declined_at IS NOT NULL OR x.rstatus NOT IN ('open', 'quoted'))::int AS decided,
           count(*) FILTER (WHERE x.quoted)::int AS quoted,
           count(*) FILTER (WHERE NOT x.quoted AND x.declined_at IS NOT NULL AND COALESCE(x.decline_reason, '') <> 'window_lapsed')::int AS declined_reason
    FROM (
      SELECT m.provider_id, m.declined_at, m.decline_reason, r.status AS rstatus,
             EXISTS (SELECT 1 FROM quotes q WHERE q.rfq_id = m.rfq_id AND q.provider_id = m.provider_id) AS quoted
      FROM rfq_matches m
      JOIN rfqs r ON r.id = m.rfq_id
      WHERE m.notified_at >= p_since AND r.category_id IS NOT NULL AND r.deleted_at IS NULL
    ) x
    GROUP BY x.provider_id
  )
  SELECT p.id,
         COALESCE(ra.n, 0),
         ra.med,
         COALESCE(dl.delivered, 0),
         COALESCE(dl.on_time, 0),
         COALESCE(od.completed, 0),
         COALESCE(od.confirmed, 0),
         COALESCE(od.auto_acc, 0),
         COALESCE(od.completed, 0) + COALESCE(rs.resolved_closed, 0),
         COALESCE(rs.at_fault, 0),
         COALESCE(mt.decided, 0),
         COALESCE(mt.quoted, 0),
         COALESCE(mt.declined_reason, 0)
  FROM provider_profiles p
  LEFT JOIN resp_agg  ra ON ra.provider_id = p.id
  LEFT JOIN deliv_agg dl ON dl.provider_id = p.id
  LEFT JOIN ord       od ON od.provider_id = p.id
  LEFT JOIN res       rs ON rs.provider_id = p.id
  LEFT JOIN mt           ON mt.provider_id = p.id
  WHERE p.deleted_at IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION score_inputs_provider(timestamptz) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION score_inputs_provider(timestamptz) TO service_role;
--> statement-breakpoint

-- ─── 2. inputs: buyer ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION score_inputs_buyer(p_since timestamptz)
RETURNS TABLE (
  msme_id                    uuid,
  confirmation_samples       integer,
  median_confirmation_hours  double precision,
  rfqs_with_quotes           integer,
  rfqs_followed_through      integer,
  closed_orders              integer,
  disputes_unfounded         integer,
  checkout_subjects_decided  integer,
  checkout_subjects_paid     integer
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
  WITH conf AS (
    -- completed in the window: deliver → accept_delivery hours; an auto-accepted order counts as 72 h
    SELECT o.msme_id,
           CASE
             WHEN a.acc_at IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM (a.acc_at - dv.first_at)) / 3600.0)
             WHEN au.x IS NOT NULL THEN 72.0
           END AS h
    FROM orders o
    JOIN LATERAL (SELECT min(e.created_at) AS first_at FROM order_events e WHERE e.order_id = o.id AND e.event = 'deliver') dv ON dv.first_at IS NOT NULL
    LEFT JOIN LATERAL (SELECT min(e.created_at) AS acc_at FROM order_events e WHERE e.order_id = o.id AND e.event = 'accept_delivery') a ON true
    LEFT JOIN LATERAL (SELECT 1 AS x FROM order_events e WHERE e.order_id = o.id AND e.event = 'auto_accepted' LIMIT 1) au ON true
    WHERE o.deleted_at IS NULL AND o.kind = 'service'
      AND o.status IN ('completed', 'reviewed') AND o.completed_at >= p_since
  ),
  conf_agg AS (
    SELECT msme_id, count(h)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY h) FILTER (WHERE h IS NOT NULL) AS med
    FROM conf GROUP BY msme_id
  ),
  ft AS (
    -- closed services RFQs created in the window that received ≥ 1 quote
    SELECT r.msme_id,
           count(*)::int AS with_quotes,
           count(*) FILTER (
             WHERE r.status = 'accepted'
                OR EXISTS (SELECT 1 FROM quotes q WHERE q.rfq_id = r.id AND q.declined_by = 'buyer')
           )::int AS followed
    FROM rfqs r
    WHERE r.deleted_at IS NULL AND r.category_id IS NOT NULL
      AND r.created_at >= p_since
      AND r.status IN ('accepted', 'expired', 'cancelled')
      AND r.quote_count > 0
    GROUP BY r.msme_id
  ),
  ord AS (
    SELECT o.msme_id, count(*)::int AS completed
    FROM orders o
    WHERE o.deleted_at IS NULL AND o.kind = 'service'
      AND o.status IN ('completed', 'reviewed') AND o.completed_at >= p_since
    GROUP BY o.msme_id
  ),
  res AS (
    SELECT o.msme_id,
           count(DISTINCT o.id) FILTER (WHERE o.status IN ('resolved_refund', 'resolved_release', 'resolved_partial'))::int AS resolved_closed,
           count(*) FILTER (WHERE d.resolution = 'release' AND d.raised_by = mp.user_id)::int AS unfounded
    FROM disputes d
    JOIN orders o ON o.id = d.order_id
    JOIN msme_profiles mp ON mp.id = o.msme_id
    WHERE o.deleted_at IS NULL AND o.kind = 'service'
      AND d.status = 'resolved' AND d.resolved_at >= p_since
    GROUP BY o.msme_id
  ),
  subj AS (
    -- per checkout SUBJECT (a quote / a package), not per session: a retried payment is not an abandonment
    SELECT s.msme_id,
           COALESCE(s.quote_id::text, s.package_id::text, s.id::text) AS subject,
           bool_or(s.status = 'materialized') AS paid,
           bool_and(s.status = 'created' AND s.expires_at < now()) AS all_expired
    FROM checkout_sessions s
    WHERE s.created_at >= p_since AND COALESCE(s.kind, 'service') = 'service'
    GROUP BY s.msme_id, 2
  ),
  subj_agg AS (
    SELECT msme_id,
           count(*) FILTER (WHERE paid OR all_expired)::int AS decided,
           count(*) FILTER (WHERE paid)::int AS paid
    FROM subj GROUP BY msme_id
  )
  SELECT m.id,
         COALESCE(ca.n, 0),
         ca.med,
         COALESCE(ft.with_quotes, 0),
         COALESCE(ft.followed, 0),
         COALESCE(od.completed, 0) + COALESCE(rs.resolved_closed, 0),
         COALESCE(rs.unfounded, 0),
         COALESCE(sa.decided, 0),
         COALESCE(sa.paid, 0)
  FROM msme_profiles m
  LEFT JOIN conf_agg ca ON ca.msme_id = m.id
  LEFT JOIN ft          ON ft.msme_id = m.id
  LEFT JOIN ord      od ON od.msme_id = m.id
  LEFT JOIN res      rs ON rs.msme_id = m.id
  LEFT JOIN subj_agg sa ON sa.msme_id = m.id
  WHERE m.deleted_at IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION score_inputs_buyer(timestamptz) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION score_inputs_buyer(timestamptz) TO service_role;
--> statement-breakpoint

-- ─── 3. snapshots ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_scores (
  provider_id    uuid NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  score_version  text NOT NULL,
  score          integer CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  components     jsonb NOT NULL,
  sample         jsonb NOT NULL,
  gated          boolean NOT NULL,
  -- the day's coaching note (score_note@v1), { on: 'YYYY-MM-DD', locale, text } — informational, may be null
  note           jsonb,
  computed_at    timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, score_version)
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS provider_scores_set_updated_at ON provider_scores;
--> statement-breakpoint
CREATE TRIGGER provider_scores_set_updated_at
  BEFORE UPDATE ON provider_scores
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS buyer_scores (
  msme_id        uuid NOT NULL REFERENCES msme_profiles(id) ON DELETE CASCADE,
  score_version  text NOT NULL,
  score          integer CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  components     jsonb NOT NULL,
  sample         jsonb NOT NULL,
  gated          boolean NOT NULL,
  computed_at    timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (msme_id, score_version)
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS buyer_scores_set_updated_at ON buyer_scores;
--> statement-breakpoint
CREATE TRIGGER buyer_scores_set_updated_at
  BEFORE UPDATE ON buyer_scores
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ─── 4. history (one row per subject per day) + events (append-only) ─────────
CREATE TABLE IF NOT EXISTS score_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type   text NOT NULL CHECK (subject_type IN ('provider', 'buyer')),
  subject_id     uuid NOT NULL,
  score_version  text NOT NULL,
  score          integer CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  components     jsonb NOT NULL,
  computed_on    date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS score_history_subject_day_uidx
  ON score_history (subject_type, subject_id, score_version, computed_on);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS score_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type   text NOT NULL CHECK (subject_type IN ('provider', 'buyer')),
  subject_id     uuid NOT NULL,
  score_version  text NOT NULL,
  delta          integer NOT NULL,
  from_score     integer,
  to_score       integer,
  -- the component that moved most (a component key), or 'gate' when the score appeared / disappeared at the gate
  reason         text NOT NULL,
  ref            jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS score_events_subject_created_idx ON score_events (subject_type, subject_id, created_at DESC);
--> statement-breakpoint
DROP TRIGGER IF EXISTS score_events_no_update ON score_events;
--> statement-breakpoint
CREATE TRIGGER score_events_no_update
  BEFORE UPDATE ON score_events
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
--> statement-breakpoint

-- ─── 5. munshi growth nudge cursor ───────────────────────────────────────────
ALTER TABLE munshi_provider_state ADD COLUMN IF NOT EXISTS last_growth_at timestamptz;
--> statement-breakpoint

-- ─── 6. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE provider_scores ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "provider_scores: own read" ON provider_scores;
--> statement-breakpoint
CREATE POLICY "provider_scores: own read" ON provider_scores
  FOR SELECT USING (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));
--> statement-breakpoint
DROP POLICY IF EXISTS "provider_scores: admin read" ON provider_scores;
--> statement-breakpoint
CREATE POLICY "provider_scores: admin read" ON provider_scores
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON provider_scores FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE buyer_scores ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "buyer_scores: admin read" ON buyer_scores;
--> statement-breakpoint
CREATE POLICY "buyer_scores: admin read" ON buyer_scores
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON buyer_scores FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE score_history ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "score_history: own provider read" ON score_history;
--> statement-breakpoint
CREATE POLICY "score_history: own provider read" ON score_history
  FOR SELECT USING (subject_type = 'provider' AND subject_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));
--> statement-breakpoint
DROP POLICY IF EXISTS "score_history: admin read" ON score_history;
--> statement-breakpoint
CREATE POLICY "score_history: admin read" ON score_history
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON score_history FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE score_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "score_events: own provider read" ON score_events;
--> statement-breakpoint
CREATE POLICY "score_events: own provider read" ON score_events
  FOR SELECT USING (subject_type = 'provider' AND subject_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));
--> statement-breakpoint
DROP POLICY IF EXISTS "score_events: admin read" ON score_events;
--> statement-breakpoint
CREATE POLICY "score_events: admin read" ON score_events
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON score_events FROM anon, authenticated;
