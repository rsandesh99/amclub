-- 0083 — rfqs.goods_spec is not client-readable (architecture + security audit,
-- 2026-09-24: M4 part 2). Split out of 0077 because it narrows a read the build
-- before 0077's code still made on the session client (the checkout quote branch).
-- ORDER: apply only after the build carrying 0077's code is live.
--
-- A matched seller could read rfqs.goods_spec (the buyer's contact name, phone and
-- street address) straight through PostgREST. Clients keep SELECT on every other rfqs
-- column; goods_spec is read only by the /api/v1 routes on the service role (buyer:
-- full; matched seller: shared goodsSpecForSeller). The column list is built from the
-- catalogue; a column added to rfqs later must be granted in its own migration if a
-- session client needs it. No-op on a database without the Mart column.
--
-- Rollback: `REVOKE SELECT ON rfqs FROM anon, authenticated; GRANT SELECT ON rfqs TO
-- anon, authenticated;` (reopens M4).

DO $rfq_cols$
DECLARE
  cols text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'rfqs' AND column_name = 'goods_spec'
  ) THEN
    RETURN;
  END IF;
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'rfqs' AND column_name <> 'goods_spec';
  EXECUTE 'REVOKE SELECT ON rfqs FROM anon, authenticated';
  EXECUTE format('GRANT SELECT (%s) ON rfqs TO anon, authenticated', cols);
END
$rfq_cols$;
