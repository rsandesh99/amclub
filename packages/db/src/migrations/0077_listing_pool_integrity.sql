-- 0077 — Mart listings, pools and group requests (architecture + security audit,
-- 2026-09-24: M4, M16, M44, L9). NOT staged: every statement that touches a staged
-- Mart table (0022–0024) is guarded with to_regclass / the catalogue, so this is a
-- no-op for those parts on a database without them. Re-running it changes nothing.
--
-- 1. M16 — a pool freezes the listing's tax identity when it opens. pools gains
--    gst_rate_bps + hsn_code (unit already lives on the pool); approveAndOpenPool
--    writes them and prepareMemberCheckout charges them, so a later listing edit
--    cannot change what a member pays. Clients may read both (like every pools column
--    except rationale, 0076; rls/policies.sql builds the same list).
--    Backfill: pools already open / closed_met take the listing's current values
--    (the seller route now refuses material edits while such a pool is live).
-- 2. M4 part 2 (the rfqs.goods_spec column grant) is migration 0083: it narrows a
--    read the previous build still uses, so it is applied after this build is live.
-- 3. M44 / L9 — a group quote names its member: quotes.pool_member_id (unique, set by
--    the close in the same INSERT). The close uses it to tell its own quote from a
--    direct one on a unique-violation replay, and the quote PATCH refuses group quotes.
--    Not client-readable (quotes has column grants since 0033; nothing grants it).
--    Backfill: from service_pool_members.quote_id (updated_at left as it was).
-- 4. L9 — service_pools.close_lease_until: a per-pool lease the close takes with a
--    compare-and-set before any claim, so two closes never run one pool at once.
--    No client grant (service_pools has none, 0071).
--
-- Additive only: the previous build ignores every column added here, so this is applied
-- before the build that uses them.
-- Rollback: DROP the added columns / constraints / index (ALTER TABLE … DROP COLUMN IF
-- EXISTS …). The app then fails closed on pool close (the lease update errors) until the
-- code is rolled back too.

-- ─── 1. pools: tax snapshot at open (M16) ────────────────────────────────────
DO $pool_snapshot$
BEGIN
  IF to_regclass('public.pools') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'ALTER TABLE pools ADD COLUMN IF NOT EXISTS gst_rate_bps integer';
  EXECUTE 'ALTER TABLE pools ADD COLUMN IF NOT EXISTS hsn_code text';
  EXECUTE 'ALTER TABLE pools DROP CONSTRAINT IF EXISTS pools_snapshot_check';
  EXECUTE $c$ALTER TABLE pools ADD CONSTRAINT pools_snapshot_check CHECK (
    (gst_rate_bps IS NULL OR gst_rate_bps IN (0, 500, 1200, 1800, 2800))
    AND (hsn_code IS NULL OR hsn_code ~ '^[0-9]{4}([0-9]{2})?([0-9]{2})?$'))$c$;
  IF to_regclass('public.products') IS NOT NULL THEN
    EXECUTE $b$UPDATE pools p
       SET gst_rate_bps = pr.gst_rate_bps, hsn_code = pr.hsn_code
      FROM products pr
     WHERE pr.id = p.product_id
       AND p.gst_rate_bps IS NULL
       AND p.status IN ('open', 'closed_met')$b$;
  END IF;
  EXECUTE 'GRANT SELECT (gst_rate_bps, hsn_code) ON pools TO anon, authenticated';
END
$pool_snapshot$;
--> statement-breakpoint

-- ─── 3. quotes.pool_member_id (M44 / L9) ─────────────────────────────────────
DO $pool_quote$
BEGIN
  IF to_regclass('public.service_pool_members') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'ALTER TABLE quotes ADD COLUMN IF NOT EXISTS pool_member_id uuid REFERENCES service_pool_members(id) ON DELETE SET NULL';
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS quotes_pool_member_uq ON quotes (pool_member_id) WHERE pool_member_id IS NOT NULL';
  IF EXISTS (
    SELECT 1 FROM quotes q JOIN service_pool_members m ON m.quote_id = q.id WHERE q.pool_member_id IS NULL
  ) THEN
    -- Keep each quote's updated_at: the marker is bookkeeping, not a revision.
    EXECUTE 'ALTER TABLE quotes DISABLE TRIGGER set_updated_at';
    EXECUTE 'UPDATE quotes q SET pool_member_id = m.id FROM service_pool_members m WHERE m.quote_id = q.id AND q.pool_member_id IS NULL';
    EXECUTE 'ALTER TABLE quotes ENABLE TRIGGER set_updated_at';
  END IF;
END
$pool_quote$;
--> statement-breakpoint

-- ─── 4. service_pools.close_lease_until (L9) ─────────────────────────────────
DO $pool_lease$
BEGIN
  IF to_regclass('public.service_pools') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'ALTER TABLE service_pools ADD COLUMN IF NOT EXISTS close_lease_until timestamptz';
END
$pool_lease$;
