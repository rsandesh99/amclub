-- Fair price ranges (BUILD_PROMPTS S3.2, A3) — additive, idempotent, NOT staged
-- (apply to prod before the writer deploys, RULES.md 2).
--
-- price_benchmarks: one row per (category, specialization, scope, state, version) that passed the privacy gates on
-- the last nightly run (cron/benchmark-compute). AGGREGATES ONLY: the table has NO id column of any kind — not a
-- surrogate key, not a provider / buyer / order / quote reference; the unique key below is its identity. The CHECKs
-- restate the floor of the privacy gates (the settings can only tighten them — 30 jobs, 8 providers, 8 buyers), the ordering p25 ≤ p50 ≤ p75,
-- and scope ⇔ state.
--
-- benchmark_inputs(p_since): SECURITY INVOKER SQL function returning one row per ELIGIBLE order — a services order
-- (orders.kind = 'service') with a captured payment, not cancelled / refunded / refund-resolved, priced at
-- orders.price_paise (ex-GST), paid on or after p_since. Category from the quote's RFQ, else the package; state = the
-- buyer's msme_profiles.state; delivery_days = first 'deliver' event minus the payment (order creation), whole days
-- rounded up. Submitted quotes are never inputs. EXECUTE for service_role only.
--
-- replace_price_benchmarks(p_version, p_rows, p_categories): the nightly write in ONE transaction (a function call
-- is atomic); p_categories (NULL = every category) limits which existing rows may be deleted — the verify rig scopes a
-- run to its own test category and can never touch a real row:
-- rows for keys no longer passing are deleted, changed rows are updated (computed_at = now(), the cached note cleared),
-- new rows inserted, unchanged rows left exactly as they were — so a second run the same day changes nothing.
-- EXECUTE for service_role only.
--
-- RLS: any signed-in user may read (aggregates only, by design); no client writes anywhere.

-- ─── 1. the table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_benchmarks (
  category_slug     text NOT NULL,
  specialization    text,
  scope             text NOT NULL CHECK (scope IN ('state', 'national')),
  state             text,
  unit              text NOT NULL DEFAULT 'job',
  version           text NOT NULL,
  sample_n          integer NOT NULL,
  providers_n       integer NOT NULL,
  buyers_n          integer NOT NULL,
  p25_paise         bigint NOT NULL,
  p50_paise         bigint NOT NULL,
  p75_paise         bigint NOT NULL,
  median_delivery_days integer,
  p25_delivery_days integer,
  p75_delivery_days integer,
  window_days       integer NOT NULL,
  notes             jsonb,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_benchmarks_percentiles_check CHECK (p25_paise > 0 AND p25_paise <= p50_paise AND p50_paise <= p75_paise),
  CONSTRAINT price_benchmarks_days_check CHECK (
    (p25_delivery_days IS NULL AND median_delivery_days IS NULL AND p75_delivery_days IS NULL)
    OR (p25_delivery_days >= 0 AND p25_delivery_days <= median_delivery_days AND median_delivery_days <= p75_delivery_days)
  ),
  CONSTRAINT price_benchmarks_scope_state_check CHECK ((scope = 'state') = (state IS NOT NULL)),
  CONSTRAINT price_benchmarks_gate_floor_check CHECK (sample_n >= 30 AND providers_n >= 8 AND buyers_n >= 8 AND providers_n <= sample_n AND buyers_n <= sample_n)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS price_benchmarks_key_uidx
  ON price_benchmarks (category_slug, (COALESCE(specialization, '')), scope, (COALESCE(state, '')), version);
--> statement-breakpoint
DROP TRIGGER IF EXISTS price_benchmarks_set_updated_at ON price_benchmarks;
--> statement-breakpoint
CREATE TRIGGER price_benchmarks_set_updated_at
  BEFORE UPDATE ON price_benchmarks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ─── 2. inputs: one row per eligible PAID services order ─────────────────────
CREATE OR REPLACE FUNCTION benchmark_inputs(p_since timestamptz)
RETURNS TABLE (
  seq           bigint,
  category_slug text,
  state         text,
  price_paise   bigint,
  provider_id   uuid,
  msme_id       uuid,
  delivery_days integer
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
  -- seq: a stable page key (the service-role reader pages 1 000 rows at a time) that exposes no order id
  SELECT row_number() OVER (ORDER BY o.created_at, o.id) AS seq,
         c.slug AS category_slug,
         NULLIF(mp.state, '') AS state,
         o.price_paise,
         o.provider_id,
         o.msme_id,
         (SELECT CEIL(EXTRACT(EPOCH FROM (min(e.created_at) - o.created_at)) / 86400.0)::int
            FROM order_events e WHERE e.order_id = o.id AND e.event = 'deliver') AS delivery_days
  FROM orders o
  JOIN msme_profiles mp ON mp.id = o.msme_id
  LEFT JOIN quotes q ON q.id = o.quote_id
  LEFT JOIN rfqs r ON r.id = q.rfq_id
  LEFT JOIN packages pk ON pk.id = o.package_id
  JOIN categories c ON c.id = COALESCE(r.category_id, pk.category_id)
  WHERE o.deleted_at IS NULL
    AND o.kind = 'service'
    AND o.created_at >= p_since
    AND o.price_paise > 0
    AND o.status NOT IN ('auto_cancelled', 'cancelled_by_buyer', 'refunded', 'resolved_refund', 'resolved_partial')
    AND EXISTS (SELECT 1 FROM payments pay WHERE pay.order_id = o.id AND pay.status = 'captured')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION benchmark_inputs(timestamptz) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION benchmark_inputs(timestamptz) TO service_role;
--> statement-breakpoint

-- ─── 3. the nightly write, atomic ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION replace_price_benchmarks(p_version text, p_rows jsonb, p_categories text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_deleted  integer := 0;
  v_updated  integer := 0;
  v_inserted integer := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'replace_price_benchmarks: p_rows must be a json array';
  END IF;

  -- keys that no longer pass the gates disappear the same night
  DELETE FROM price_benchmarks b
  WHERE b.version = p_version
    AND (p_categories IS NULL OR b.category_slug = ANY (p_categories))
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_rows) AS i(category_slug text, specialization text, scope text, state text)
      WHERE i.category_slug = b.category_slug AND COALESCE(i.specialization, '') = COALESCE(b.specialization, '')
        AND i.scope = b.scope AND COALESCE(i.state, '') = COALESCE(b.state, ''));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- changed numbers → new computed_at, the cached note cleared; identical rows are not touched
  UPDATE price_benchmarks b
  SET sample_n = i.sample_n, providers_n = i.providers_n, buyers_n = i.buyers_n,
      p25_paise = i.p25_paise, p50_paise = i.p50_paise, p75_paise = i.p75_paise,
      median_delivery_days = i.median_delivery_days, p25_delivery_days = i.p25_delivery_days, p75_delivery_days = i.p75_delivery_days,
      window_days = i.window_days, notes = NULL, computed_at = now()
  FROM jsonb_to_recordset(p_rows) AS i(category_slug text, specialization text, scope text, state text,
       sample_n integer, providers_n integer, buyers_n integer, p25_paise bigint, p50_paise bigint, p75_paise bigint,
       median_delivery_days integer, p25_delivery_days integer, p75_delivery_days integer, window_days integer)
  WHERE b.version = p_version
    AND i.category_slug = b.category_slug AND COALESCE(i.specialization, '') = COALESCE(b.specialization, '')
    AND i.scope = b.scope AND COALESCE(i.state, '') = COALESCE(b.state, '')
    AND (b.sample_n, b.providers_n, b.buyers_n, b.p25_paise, b.p50_paise, b.p75_paise,
         b.median_delivery_days, b.p25_delivery_days, b.p75_delivery_days, b.window_days)
        IS DISTINCT FROM
        (i.sample_n, i.providers_n, i.buyers_n, i.p25_paise, i.p50_paise, i.p75_paise,
         i.median_delivery_days, i.p25_delivery_days, i.p75_delivery_days, i.window_days);
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  INSERT INTO price_benchmarks (category_slug, specialization, scope, state, version, sample_n, providers_n, buyers_n,
                                p25_paise, p50_paise, p75_paise, median_delivery_days, p25_delivery_days, p75_delivery_days, window_days)
  SELECT i.category_slug, i.specialization, i.scope, i.state, p_version, i.sample_n, i.providers_n, i.buyers_n,
         i.p25_paise, i.p50_paise, i.p75_paise, i.median_delivery_days, i.p25_delivery_days, i.p75_delivery_days, i.window_days
  FROM jsonb_to_recordset(p_rows) AS i(category_slug text, specialization text, scope text, state text,
       sample_n integer, providers_n integer, buyers_n integer, p25_paise bigint, p50_paise bigint, p75_paise bigint,
       median_delivery_days integer, p25_delivery_days integer, p75_delivery_days integer, window_days integer)
  WHERE NOT EXISTS (
    SELECT 1 FROM price_benchmarks b
    WHERE b.version = p_version AND b.category_slug = i.category_slug AND COALESCE(b.specialization, '') = COALESCE(i.specialization, '')
      AND b.scope = i.scope AND COALESCE(b.state, '') = COALESCE(i.state, ''));
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RETURN jsonb_build_object('deleted', v_deleted, 'updated', v_updated, 'inserted', v_inserted);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION replace_price_benchmarks(text, jsonb, text[]) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION replace_price_benchmarks(text, jsonb, text[]) TO service_role;
--> statement-breakpoint

-- ─── 4. RLS: any signed-in user reads aggregates; nobody writes but the service role ─
ALTER TABLE price_benchmarks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "price_benchmarks: authenticated read" ON price_benchmarks;
--> statement-breakpoint
CREATE POLICY "price_benchmarks: authenticated read" ON price_benchmarks
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
-- every client privilege off (incl. TRUNCATE / REFERENCES / TRIGGER), then SELECT for signed-in users — the S2.4 / PR #15 rule
REVOKE ALL ON price_benchmarks FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON price_benchmarks TO authenticated;
