-- Experience v3 E2a — search v2 (docs/prd/PRD_EXPERIENCE_V3.md §6 E2, FR-2.1 / FR-2.6).
-- Additive: search_packages (v1, 0047) is untouched and still serves every
-- surface while EXP_V3_SEARCH is off; the app falls back to it on any v2 error.
--
-- 1. packages.service_slug — the level-2 service (the shared SPECIALIZATIONS
--    vocabulary; validated by the app). Nullable: a package with none still
--    lists under its category.
-- 2. search_packages_v2 — the v1 filters plus service, city, credential,
--    response time, delivery time and a price band on the price the buyer
--    pays before GST (after the package discount). Sorts: best (default —
--    text rank × trust; NEVER a paid signal, there is none), rating,
--    price_asc, price_desc, fastest, newest. Rows carry text_rank.
-- 3. search_facets_v2 — counts per facet value for the desktop rail. Each
--    facet ignores its own filter (you see the other states while one is
--    picked); every other filter applies.
-- 4. search_feedback (N6) — "Did you find what you need?". Service role
--    writes only; no client reads.
--
-- Rollback: DROP FUNCTION search_facets_v2, search_packages_v2; DROP TABLE
-- search_feedback; DROP INDEX packages_service_slug_idx; ALTER TABLE packages
-- DROP CONSTRAINT packages_service_slug_check, DROP COLUMN service_slug;

ALTER TABLE packages ADD COLUMN IF NOT EXISTS service_slug text;
--> statement-breakpoint
ALTER TABLE packages DROP CONSTRAINT IF EXISTS packages_service_slug_check;
--> statement-breakpoint
ALTER TABLE packages ADD CONSTRAINT packages_service_slug_check CHECK (service_slug IS NULL OR service_slug ~ '^[a-z0-9-]{1,48}$');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS packages_service_slug_idx ON packages (service_slug) WHERE service_slug IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS search_feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  query       text CHECK (query IS NULL OR char_length(query) <= 200),
  filters     jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_ids  uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(result_ids) <= 24),
  helpful     boolean NOT NULL,
  reason      text CHECK (reason IS NULL OR reason IN ('not_relevant', 'too_expensive', 'too_slow', 'not_in_my_state')),
  surface     text NOT NULL DEFAULT 'web' CHECK (surface IN ('web', 'mobile')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS search_feedback_created_idx ON search_feedback (created_at DESC);
--> statement-breakpoint
ALTER TABLE search_feedback ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON search_feedback FROM anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS search_feedback_set_updated_at ON search_feedback;
--> statement-breakpoint
CREATE TRIGGER search_feedback_set_updated_at BEFORE UPDATE ON search_feedback
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION search_packages_v2(
  p_query                 text    DEFAULT NULL,
  p_category_slug         text    DEFAULT NULL,
  p_service_slug          text    DEFAULT NULL,
  p_state                 text    DEFAULT NULL,
  p_city                  text    DEFAULT NULL,
  p_credential            text    DEFAULT NULL,
  p_response_max_minutes  int     DEFAULT NULL,
  p_delivery_max_days     int     DEFAULT NULL,
  p_min_price             bigint  DEFAULT NULL,
  p_max_price             bigint  DEFAULT NULL,
  p_min_rating            numeric DEFAULT NULL,
  p_language              text    DEFAULT NULL,
  p_verified_only         boolean DEFAULT false,
  p_sort                  text    DEFAULT 'best',
  p_limit                 int     DEFAULT 24,
  p_offset                int     DEFAULT 0
)
RETURNS TABLE (
  package_id                uuid,
  package_slug              text,
  title_i18n                jsonb,
  price_paise               bigint,
  discount_bps              int,
  member_extra_discount_bps int,
  delivery_days             int,
  revision_count            int,
  service_slug              text,
  category_id               uuid,
  category_slug             text,
  category_name_i18n        jsonb,
  provider_id               uuid,
  provider_slug             text,
  display_name              text,
  logo_url                  text,
  state                     text,
  city                      text,
  languages                 text[],
  avg_rating                numeric,
  review_count              int,
  completed_orders          int,
  median_response_minutes   int,
  top_rated                 boolean,
  verified                  boolean,
  headline_credential       text,
  text_rank                 real,
  total_count               bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH q AS (
    SELECT CASE WHEN coalesce(btrim(p_query), '') = '' THEN NULL ELSE websearch_to_tsquery('english', p_query) END AS tsq
  ),
  base AS (
    SELECT
      pk.id AS package_id, pk.slug AS package_slug, pk.title_i18n,
      pk.price_paise, pk.discount_bps, pk.member_extra_discount_bps,
      pk.delivery_days, pk.revision_count, pk.service_slug,
      pk.created_at AS package_created_at,
      -- What the buyer pays before GST (computeOrderAmounts: price − round(price × discount)).
      pk.price_paise - round(pk.price_paise * pk.discount_bps / 10000.0)::bigint AS taxable_paise,
      c.id AS category_id, c.slug AS category_slug, c.name_i18n AS category_name_i18n,
      pp.id AS provider_id, pp.slug AS provider_slug, pp.display_name, pp.logo_url,
      pp.state, pp.city, pp.languages,
      pp.avg_rating::numeric AS avg_rating, pp.review_count, pp.completed_orders,
      pp.median_response_minutes, pp.top_rated,
      EXISTS (
        SELECT 1 FROM provider_verifications v
        WHERE v.provider_id = pp.id AND v.status IN ('manually_approved', 'api_verified')
      ) AS verified,
      (
        SELECT v.kind FROM provider_verifications v
        WHERE v.provider_id = pp.id
          AND v.status IN ('manually_approved', 'api_verified')
          AND v.kind IN ('icai', 'icsi', 'bar_council', 'ca', 'credential')
        ORDER BY array_position(ARRAY['icai','icsi','bar_council','ca','credential'], v.kind)
        LIMIT 1
      ) AS headline_credential,
      CASE WHEN q.tsq IS NULL THEN 1.0::real ELSE ts_rank_cd(pk.search_tsv, q.tsq) END AS text_rank,
      -- Rating = review-count-weighted (5 phantom reviews at 4.0), as in 0047.
      (coalesce(pp.avg_rating::numeric, 0) * coalesce(pp.review_count, 0) + 4.0 * 5) / (coalesce(pp.review_count, 0) + 5) AS rating_bayes
    FROM packages pk
    JOIN provider_profiles pp ON pp.id = pk.provider_id
    JOIN categories c         ON c.id = pk.category_id
    CROSS JOIN q
    WHERE pk.status = 'active' AND pk.deleted_at IS NULL
      AND pp.status = 'active' AND pp.deleted_at IS NULL
      AND (q.tsq IS NULL OR pk.search_tsv @@ q.tsq)
      AND (p_category_slug IS NULL OR c.slug = p_category_slug)
      AND (p_service_slug  IS NULL OR pk.service_slug = p_service_slug)
      AND (p_state         IS NULL OR pp.state = p_state)
      AND (p_city          IS NULL OR lower(pp.city) = lower(p_city))
      AND (p_response_max_minutes IS NULL OR pp.median_response_minutes <= p_response_max_minutes)
      AND (p_delivery_max_days    IS NULL OR pk.delivery_days <= p_delivery_max_days)
      AND (p_min_rating    IS NULL OR pp.avg_rating::numeric >= p_min_rating)
      AND (p_language      IS NULL OR p_language = ANY(pp.languages))
      AND (
        p_credential IS NULL
        OR (p_credential = 'udyam' AND pp.udyam_verified)
        OR EXISTS (
          SELECT 1 FROM provider_verifications v
          WHERE v.provider_id = pp.id AND v.kind = p_credential
            AND v.status IN ('manually_approved', 'api_verified')
        )
      )
      AND (
        NOT p_verified_only OR EXISTS (
          SELECT 1 FROM provider_verifications v
          WHERE v.provider_id = pp.id AND v.status IN ('manually_approved', 'api_verified')
        )
      )
  ),
  priced AS (
    SELECT * FROM base
    WHERE (p_min_price IS NULL OR taxable_paise >= p_min_price)
      AND (p_max_price IS NULL OR taxable_paise <= p_max_price)
  )
  SELECT
    b.package_id, b.package_slug, b.title_i18n,
    b.price_paise, b.discount_bps, b.member_extra_discount_bps,
    b.delivery_days, b.revision_count, b.service_slug,
    b.category_id, b.category_slug, b.category_name_i18n,
    b.provider_id, b.provider_slug, b.display_name, b.logo_url,
    b.state, b.city, b.languages,
    b.avg_rating, b.review_count, b.completed_orders,
    b.median_response_minutes, b.top_rated, b.verified,
    b.headline_credential, b.text_rank,
    count(*) OVER() AS total_count
  FROM priced b
  ORDER BY
    -- best:begin — the ONLY inputs are text relevance, the weighted rating and
    -- verification (PRD FR-2.1: never a paid signal). Checked by a shared test.
    (CASE WHEN p_sort = 'best' THEN
       b.text_rank * (0.5 + 0.1 * b.rating_bayes) * (CASE WHEN b.verified THEN 1.15 ELSE 1.0 END)
     END) DESC NULLS LAST,
    -- best:end
    (CASE WHEN p_sort = 'rating'     THEN b.rating_bayes          END) DESC NULLS LAST,
    (CASE WHEN p_sort = 'price_desc' THEN b.taxable_paise         END) DESC NULLS LAST,
    (CASE WHEN p_sort = 'price_asc'  THEN b.taxable_paise         END) ASC  NULLS LAST,
    (CASE WHEN p_sort = 'fastest'    THEN b.delivery_days         END) ASC  NULLS LAST,
    (CASE WHEN p_sort = 'fastest'    THEN b.median_response_minutes END) ASC NULLS LAST,
    (CASE WHEN p_sort = 'newest'     THEN b.package_created_at    END) DESC NULLS LAST,
    b.rating_bayes DESC, b.review_count DESC NULLS LAST, b.package_id
  LIMIT  LEAST(GREATEST(p_limit, 1), 96)
  OFFSET GREATEST(p_offset, 0);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION search_facets_v2(
  p_query                 text    DEFAULT NULL,
  p_category_slug         text    DEFAULT NULL,
  p_service_slug          text    DEFAULT NULL,
  p_state                 text    DEFAULT NULL,
  p_city                  text    DEFAULT NULL,
  p_credential            text    DEFAULT NULL,
  p_response_max_minutes  int     DEFAULT NULL,
  p_delivery_max_days     int     DEFAULT NULL,
  p_min_price             bigint  DEFAULT NULL,
  p_max_price             bigint  DEFAULT NULL,
  p_min_rating            numeric DEFAULT NULL,
  p_language              text    DEFAULT NULL,
  p_verified_only         boolean DEFAULT false
)
RETURNS TABLE (facet text, value text, n bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH q AS (
    SELECT CASE WHEN coalesce(btrim(p_query), '') = '' THEN NULL ELSE websearch_to_tsquery('english', p_query) END AS tsq
  ),
  base AS (
    SELECT
      c.slug AS category_slug, pk.service_slug, pp.state, pp.languages, pk.delivery_days,
      pp.avg_rating::numeric AS avg_rating,
      ARRAY(
        SELECT DISTINCT v.kind FROM provider_verifications v
        WHERE v.provider_id = pp.id AND v.status IN ('manually_approved', 'api_verified')
          AND v.kind NOT IN ('pan', 'bank')
      ) || (CASE WHEN pp.udyam_verified THEN ARRAY['udyam'] ELSE ARRAY[]::text[] END) AS kinds,
      EXISTS (
        SELECT 1 FROM provider_verifications v
        WHERE v.provider_id = pp.id AND v.status IN ('manually_approved', 'api_verified')
      ) AS verified,
      pk.price_paise - round(pk.price_paise * pk.discount_bps / 10000.0)::bigint AS taxable_paise
    FROM packages pk
    JOIN provider_profiles pp ON pp.id = pk.provider_id
    JOIN categories c         ON c.id = pk.category_id
    CROSS JOIN q
    WHERE pk.status = 'active' AND pk.deleted_at IS NULL
      AND pp.status = 'active' AND pp.deleted_at IS NULL
      AND (q.tsq IS NULL OR pk.search_tsv @@ q.tsq)
      -- Not faceted: city, response time and price apply to every count.
      AND (p_city IS NULL OR lower(pp.city) = lower(p_city))
      AND (p_response_max_minutes IS NULL OR pp.median_response_minutes <= p_response_max_minutes)
  ),
  m AS (
    SELECT b.*,
      (p_category_slug IS NULL OR b.category_slug = p_category_slug)            AS m_cat,
      (p_service_slug  IS NULL OR b.service_slug = p_service_slug)              AS m_svc,
      (p_state         IS NULL OR b.state = p_state)                            AS m_state,
      (p_credential    IS NULL OR p_credential = ANY(b.kinds))                  AS m_cred,
      (p_language      IS NULL OR p_language = ANY(b.languages))                AS m_lang,
      (NOT p_verified_only OR b.verified)                                       AS m_ver,
      (p_delivery_max_days IS NULL OR b.delivery_days <= p_delivery_max_days)   AS m_del,
      (p_min_rating    IS NULL OR b.avg_rating >= p_min_rating)                 AS m_rat,
      ((p_min_price IS NULL OR b.taxable_paise >= p_min_price) AND (p_max_price IS NULL OR b.taxable_paise <= p_max_price)) AS m_price
    FROM base b
  )
  SELECT 'category', category_slug, count(*) FROM m
    WHERE m_svc AND m_state AND m_cred AND m_lang AND m_ver AND m_del AND m_rat AND m_price GROUP BY category_slug
  UNION ALL
  SELECT 'service', service_slug, count(*) FROM m
    WHERE service_slug IS NOT NULL AND m_cat AND m_state AND m_cred AND m_lang AND m_ver AND m_del AND m_rat AND m_price GROUP BY service_slug
  UNION ALL
  SELECT 'state', state, count(*) FROM m
    WHERE m_cat AND m_svc AND m_cred AND m_lang AND m_ver AND m_del AND m_rat AND m_price GROUP BY state
  UNION ALL
  SELECT 'credential', k, count(*) FROM m, unnest(m.kinds) AS k
    WHERE m_cat AND m_svc AND m_state AND m_lang AND m_ver AND m_del AND m_rat AND m_price GROUP BY k
  UNION ALL
  SELECT 'language', l, count(*) FROM m, unnest(m.languages) AS l
    WHERE m_cat AND m_svc AND m_state AND m_cred AND m_ver AND m_del AND m_rat AND m_price GROUP BY l
  UNION ALL
  SELECT 'verified', 'true', count(*) FROM m
    WHERE verified AND m_cat AND m_svc AND m_state AND m_cred AND m_lang AND m_del AND m_rat AND m_price
  UNION ALL
  SELECT 'delivery', d::text, count(*) FROM m, (VALUES (3), (7), (14)) AS dv(d)
    WHERE m.delivery_days <= dv.d AND m_cat AND m_svc AND m_state AND m_cred AND m_lang AND m_ver AND m_rat AND m_price GROUP BY dv.d
  UNION ALL
  SELECT 'rating', r::text, count(*) FROM m, (VALUES (3.5), (4.0), (4.5)) AS rv(r)
    WHERE m.avg_rating >= rv.r AND m_cat AND m_svc AND m_state AND m_cred AND m_lang AND m_ver AND m_del AND m_price GROUP BY rv.r
  UNION ALL
  SELECT 'total', 'all', count(*) FROM m
    WHERE m_cat AND m_svc AND m_state AND m_cred AND m_lang AND m_ver AND m_del AND m_rat AND m_price;
$$;
