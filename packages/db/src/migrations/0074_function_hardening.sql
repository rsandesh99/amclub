-- 0074 — Function hardening (architecture + security audit, 2026-09-24: M1 and the
-- Supabase security advisors). No data changes.
--
-- 1. generate_order_number() was EXECUTE for PUBLIC, so anyone with the anon key could
--    call it over /rest/v1/rpc and burn the order sequence. Only the orders.order_number
--    DEFAULT needs it, and orders are server-written (ADR 018). Its LPAD also TRUNCATED
--    numbers past 999,999 to six digits, which would collide on the UNIQUE order_number
--    and fail materialize_order; the width now grows instead.
-- 2. Two SECURITY DEFINER trigger functions were EXECUTE for PUBLIC (advisor 0028/0029).
--    A trigger fires without the caller holding EXECUTE, so nothing depends on it.
--    auth_user_id / has_role / is_provider_matched_to_rfq stay callable: RLS policies
--    evaluated for anon and authenticated call them.
-- 3. Fifteen functions had a role-mutable search_path (advisor 0011). None calls an
--    extension; each is pinned to public (then pg_temp, so a temp object never shadows).

-- ─── 1. generate_order_number ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS text LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  n text := nextval('order_number_seq')::text;
BEGIN
  RETURN 'AMC-' || to_char(now(), 'YYYY') || '-' || lpad(n, greatest(6, length(n)), '0');
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION generate_order_number() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION generate_order_number() TO service_role;
--> statement-breakpoint
REVOKE ALL ON SEQUENCE order_number_seq FROM anon, authenticated;
--> statement-breakpoint

-- ─── 2. SECURITY DEFINER trigger functions: not callable over RPC ────────────
REVOKE EXECUTE ON FUNCTION packages_group_same_provider() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION recompute_provider_rating() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint

-- ─── 3. Pinned search_path ───────────────────────────────────────────────────
DO $pin$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'set_updated_at()', 'packages_tsv_update()', 'auth_user_id()', 'has_role(text)',
    'claim_quote_slot(uuid)', 'release_quote_slot(uuid)', 'increment_coupon_usage(uuid)',
    'quote_events_append_only()', 'raise_append_only()', 'payout_dossiers_decision_once()',
    'dispute_triages_decision_once()', 'users_roles_guard()', 'package_addons_limit()',
    'service_pool_claim(uuid)'
  ] LOOP
    -- A function that is absent on this database (an agent table not yet created) is skipped.
    IF to_regprocedure('public.' || f) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION public.%s SET search_path = public, pg_temp', f);
    END IF;
  END LOOP;
END
$pin$;
