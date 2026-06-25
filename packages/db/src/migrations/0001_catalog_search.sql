-- Phase 3 — Catalog search RPC.
-- Single indexed query: Postgres FTS on packages.search_tsv + structured filters,
-- rating cast (avg_rating is stored as text), verified-only join, sort, pagination.
-- SECURITY DEFINER so the verified-status subquery can read provider_verifications
-- (owner/admin-only under RLS) — the function returns only public-safe columns.

-- Supporting index for price sort/filter (GIN on search_tsv already exists from 0000).
CREATE INDEX IF NOT EXISTS packages_price_idx ON packages (price_paise);

CREATE OR REPLACE FUNCTION search_packages(
  p_query           text    DEFAULT NULL,
  p_category_slug   text    DEFAULT NULL,
  p_state           text    DEFAULT NULL,
  p_min_price       bigint  DEFAULT NULL,
  p_max_price       bigint  DEFAULT NULL,
  p_min_rating      numeric DEFAULT NULL,
  p_language        text    DEFAULT NULL,
  p_verified_only   boolean DEFAULT false,
  p_sort            text    DEFAULT 'rating',   -- rating | price_asc | price_desc | newest
  p_limit           int     DEFAULT 20,
  p_offset          int     DEFAULT 0
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
  total_count               bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH base AS (
    SELECT
      pk.id            AS package_id,
      pk.slug          AS package_slug,
      pk.title_i18n,
      pk.price_paise,
      pk.discount_bps,
      pk.member_extra_discount_bps,
      pk.delivery_days,
      pk.revision_count,
      pk.created_at    AS package_created_at,
      c.id             AS category_id,
      c.slug           AS category_slug,
      c.name_i18n      AS category_name_i18n,
      pp.id            AS provider_id,
      pp.slug          AS provider_slug,
      pp.display_name,
      pp.logo_url,
      pp.state,
      pp.city,
      pp.languages,
      pp.avg_rating::numeric AS avg_rating,
      pp.review_count,
      pp.completed_orders,
      pp.median_response_minutes,
      pp.top_rated,
      EXISTS (
        SELECT 1 FROM provider_verifications v
        WHERE v.provider_id = pp.id
          AND v.status IN ('manually_approved', 'api_verified')
      ) AS verified
    FROM packages pk
    JOIN provider_profiles pp ON pp.id = pk.provider_id
    JOIN categories c         ON c.id = pk.category_id
    WHERE pk.status = 'active' AND pk.deleted_at IS NULL
      AND pp.status = 'active' AND pp.deleted_at IS NULL
      AND (p_category_slug IS NULL OR c.slug = p_category_slug)
      AND (p_state         IS NULL OR pp.state = p_state)
      AND (p_min_price     IS NULL OR pk.price_paise >= p_min_price)
      AND (p_max_price     IS NULL OR pk.price_paise <= p_max_price)
      AND (p_min_rating    IS NULL OR pp.avg_rating::numeric >= p_min_rating)
      AND (p_language      IS NULL OR p_language = ANY(pp.languages))
      AND (
        p_query IS NULL OR p_query = ''
        OR pk.search_tsv @@ websearch_to_tsquery('english', p_query)
      )
      AND (
        NOT p_verified_only OR EXISTS (
          SELECT 1 FROM provider_verifications v
          WHERE v.provider_id = pp.id
            AND v.status IN ('manually_approved', 'api_verified')
        )
      )
  )
  SELECT
    b.package_id, b.package_slug, b.title_i18n,
    b.price_paise, b.discount_bps, b.member_extra_discount_bps,
    b.delivery_days, b.revision_count,
    b.category_id, b.category_slug, b.category_name_i18n,
    b.provider_id, b.provider_slug, b.display_name, b.logo_url,
    b.state, b.city, b.languages,
    b.avg_rating, b.review_count, b.completed_orders,
    b.median_response_minutes, b.top_rated, b.verified,
    count(*) OVER() AS total_count
  FROM base b
  ORDER BY
    (CASE WHEN p_sort = 'rating'     THEN b.avg_rating          END) DESC NULLS LAST,
    (CASE WHEN p_sort = 'price_desc' THEN b.price_paise         END) DESC NULLS LAST,
    (CASE WHEN p_sort = 'price_asc'  THEN b.price_paise         END) ASC  NULLS LAST,
    (CASE WHEN p_sort = 'newest'     THEN b.package_created_at  END) DESC NULLS LAST,
    b.top_rated DESC, b.avg_rating DESC, b.package_id
  LIMIT  GREATEST(p_limit, 1)
  OFFSET GREATEST(p_offset, 0);
$$;
