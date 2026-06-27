-- Phase 6 — Reviews & engagement glue (functions/triggers only; tables + RLS
-- already shipped in 0000). Idempotent: safe to re-run.

-- ── Denormalised provider rating (§5.5) ──────────────────────────────────────
-- Keep provider_profiles.avg_rating + review_count consistent with the set of
-- PUBLISHED reviews. Recomputes on insert, status change (publish/flag/remove),
-- rating change, and delete — NOT on a plain provider_reply update.
-- SECURITY DEFINER so an MSME's RLS-scoped review insert can still update the
-- provider's denormalised counters (the MSME cannot write provider_profiles).
CREATE OR REPLACE FUNCTION recompute_provider_rating() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  pid uuid := COALESCE(NEW.provider_id, OLD.provider_id);
BEGIN
  UPDATE provider_profiles p SET
    review_count = sub.cnt,
    avg_rating   = sub.avg
  FROM (
    SELECT
      count(*)::int AS cnt,
      COALESCE(round(avg(rating)::numeric, 1), 0.0)::text AS avg
    FROM reviews
    WHERE provider_id = pid AND status = 'published'
  ) sub
  WHERE p.id = pid;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS reviews_recompute_rating ON reviews;
CREATE TRIGGER reviews_recompute_rating
AFTER INSERT OR DELETE OR UPDATE OF status, rating ON reviews
FOR EACH ROW EXECUTE FUNCTION recompute_provider_rating();

-- ── Coupon usage increment (§5.5) ────────────────────────────────────────────
-- Atomic single-statement bump; called once per redemption from the materialise
-- path (webhook-as-truth), guarded by the (coupon_id, order_id) PK upstream.
CREATE OR REPLACE FUNCTION increment_coupon_usage(p_coupon_id uuid) RETURNS void
LANGUAGE sql AS $$
  UPDATE coupons SET used_count = used_count + 1, updated_at = now() WHERE id = p_coupon_id;
$$;
