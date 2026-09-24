-- 0076 — Mart pool rationale is admin-only (architecture + security audit, 2026-09-24: M15).
-- No data changes.
--
-- pools.rationale holds the group-buy agent's evidence: source order ids, the seller's
-- 30-day volume and buyer counts. "pools: public read live" let the anon key read it
-- straight through PostgREST (the public API now drops it too: publicPool). Clients keep
-- SELECT on every other column; the admin console reads with the service role.
--
-- The column list is built from the catalogue, so this stays correct on any database.
-- A column added to pools later must be granted in its own migration.
DO $pool_cols$
DECLARE
  cols text;
BEGIN
  IF to_regclass('public.pools') IS NOT NULL THEN
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pools' AND column_name <> 'rationale';
    EXECUTE 'REVOKE SELECT ON pools FROM anon, authenticated';
    EXECUTE format('GRANT SELECT (%s) ON pools TO anon, authenticated', cols);
  END IF;
END
$pool_cols$;
