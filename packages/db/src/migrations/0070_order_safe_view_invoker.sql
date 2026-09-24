-- ADR 022 security hotfix — order_safe_view read every order as its owner.
--
-- The view is `SELECT o.*, <buyer phone> FROM orders o` with no WHERE. It was
-- created without security_invoker, so it ran with its owner's rights
-- (postgres, BYPASSRLS): the orders policies never applied. Supabase's default
-- privileges granted SELECT on it to anon and authenticated, so with the public
-- anon key alone `GET /rest/v1/order_safe_view` returned EVERY order (amounts,
-- parties, scope) plus every buyer's phone number. No app code reads the view
-- (grep: only a fixture script), so nothing depended on the owner's rights.
--
--   1. security_invoker = true: the caller's RLS on orders, users and
--      msme_profiles applies. A party sees only their own orders; the phone
--      column is the buyer's own number for the buyer (and for admin / ops)
--      and NULL for everyone else (users is owner + admin read only, 0042).
--   2. anon holds nothing on it; authenticated holds SELECT only (the view is
--      auto-updatable, and orders writes are server-only since ADR 018).
--
-- rls/policies.sql and the staged 0022 rebuild carry the same definition, so a
-- re-run of either (DROP + CREATE re-grants by default privileges) stays closed.
-- verify-authz §7a5 proves it on every PR.
--
-- Rollback (reopens the hole; not recommended):
--   ALTER VIEW order_safe_view SET (security_invoker = false);
--   GRANT ALL ON order_safe_view TO anon, authenticated;

ALTER VIEW order_safe_view SET (security_invoker = true);
--> statement-breakpoint
REVOKE ALL ON order_safe_view FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON order_safe_view TO authenticated;
