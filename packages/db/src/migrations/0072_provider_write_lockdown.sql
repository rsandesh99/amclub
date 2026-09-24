-- 0072 — Security hotfix (architecture + security audit, 2026-09-24; ADR-025).
--
-- Client roles could WRITE provider and catalog rows directly through PostgREST:
--   1. public_providers is an auto-updatable view that runs as its owner, so RLS on
--      provider_profiles never applied to it. It kept the default ALL grant, which let the
--      ANON key UPDATE any active provider (pause, rename, fake ratings) or DELETE one.
--   2. provider_profiles / provider_categories (and Mart products / price_tiers) kept the
--      default INSERT/UPDATE/DELETE grants under "owner all" policies. Any signed-in user
--      could self-activate as a provider, lift a suspension, set sells_goods or
--      udyam_verified, forge ratings, or join credential-gated categories.
--   (packages has the same shape; 0073 closes it once the partner routes write with
--    the service role.)
--   3. buyer_pool_discipline_v1 is a definer view granted to every signed-in user, so
--      anyone could read every buyer's pool commitment and default counts.
-- Every legitimate writer is a /api/v1 route or job on the service role after its own
-- authorisation (ADR-018), so this revokes privileges nothing uses. Owners keep READ.
-- The same statements are mirrored in rls/policies.sql. verify-authz §7a6 proves it.

-- ─── 1. public_providers: read-only for everyone ─────────────────────────────
-- The view is created by rls/policies.sql, which a fresh bootstrap applies after the
-- migrations (and which carries the same REVOKE / GRANT), so it may not exist yet.
DO $view$
BEGIN
  IF to_regclass('public.public_providers') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public_providers FROM anon, authenticated';
    EXECUTE 'GRANT SELECT ON public_providers TO anon, authenticated';
  END IF;
END
$view$;
--> statement-breakpoint

-- ─── 2. provider_profiles: owner read-only, writes are the service role ──────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON provider_profiles FROM anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "provider_profiles: owner all" ON provider_profiles;
--> statement-breakpoint
DROP POLICY IF EXISTS "provider_profiles: owner read" ON provider_profiles;
--> statement-breakpoint
CREATE POLICY "provider_profiles: owner read" ON provider_profiles
  FOR SELECT USING (user_id = auth_user_id());
--> statement-breakpoint

-- ─── provider_categories: public read stays; writes are the service role ─────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON provider_categories FROM anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "provider_categories: owner all" ON provider_categories;
--> statement-breakpoint

-- ─── Mart (staged 0022/0023; absent on a database without them) ─────────────
DO $lockdown$
BEGIN
  IF to_regclass('public.products') IS NOT NULL THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON products FROM anon, authenticated';
    EXECUTE 'DROP POLICY IF EXISTS "products: seller crud own" ON products';
    EXECUTE 'DROP POLICY IF EXISTS "products: seller read own" ON products';
    EXECUTE 'CREATE POLICY "products: seller read own" ON products FOR SELECT
      USING (seller_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()))';
  END IF;
  IF to_regclass('public.price_tiers') IS NOT NULL THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON price_tiers FROM anon, authenticated';
    EXECUTE 'DROP POLICY IF EXISTS "price_tiers: seller crud own" ON price_tiers';
    EXECUTE 'DROP POLICY IF EXISTS "price_tiers: seller read own" ON price_tiers';
    EXECUTE 'CREATE POLICY "price_tiers: seller read own" ON price_tiers FOR SELECT
      USING (product_id IN (SELECT id FROM products WHERE seller_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())))';
  END IF;
  -- ─── 3. buyer_pool_discipline_v1: the caller's RLS, and no client grant ────
  IF to_regclass('public.buyer_pool_discipline_v1') IS NOT NULL THEN
    EXECUTE 'ALTER VIEW buyer_pool_discipline_v1 SET (security_invoker = true)';
    EXECUTE 'REVOKE ALL ON buyer_pool_discipline_v1 FROM anon, authenticated';
  END IF;
END
$lockdown$;
