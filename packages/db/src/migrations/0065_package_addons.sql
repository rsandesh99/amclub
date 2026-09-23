-- Experience v3 E12a (N15) — package add-ons (ADR 019). Money; ships dark behind
-- agent_settings.addons_enabled (default off). Depends on 0064 (ADR 018): the
-- snapshot below is frozen on a checkout session no client can rewrite.
--
--   package_addons        up to 3 ACTIVE priced extras per package (trigger +
--                         shared Zod). Anyone reads the active add-ons of an
--                         active package; the provider reads all of their own;
--                         no client writes (the partner routes write with the
--                         service role after checking ownership).
--   checkout_sessions.addons / orders.addons
--                         [{ id, label, pricePaise, daysDelta, extraRevisions }]
--                         frozen at session creation; NULL for every order
--                         without add-ons (all orders before this migration).
--   checkout_sessions_copy_addons
--                         copies the snapshot onto the order in the same
--                         transaction that links the session to its order
--                         (materialize_order sets order_id), so neither the
--                         current materialize_order (0003) nor the staged Mart
--                         one (0022) is redefined. It fires only when order_id
--                         is first set, so a replayed webhook copies nothing.
--
-- Backfill: none (new table; NULL snapshot = no add-ons).
-- Rollback: DROP TRIGGER checkout_sessions_copy_addons ON checkout_sessions;
--   DROP FUNCTION checkout_sessions_copy_addons(); DROP TRIGGER
--   package_addons_limit ON package_addons; DROP FUNCTION package_addons_limit();
--   DROP TABLE package_addons; ALTER TABLE orders DROP COLUMN addons;
--   ALTER TABLE checkout_sessions DROP COLUMN addons;
--   (after turning addons_enabled off; paid orders keep their invoices).

CREATE TABLE IF NOT EXISTS package_addons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id       uuid NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  label_i18n       jsonb NOT NULL CHECK (
                     jsonb_typeof(label_i18n) = 'object'
                     AND char_length(coalesce(label_i18n->>'en', '')) BETWEEN 1 AND 40
                     AND char_length(coalesce(label_i18n->>'hi', '')) <= 40
                     AND char_length(coalesce(label_i18n->>'te', '')) <= 40
                     AND char_length(coalesce(label_i18n->>'ta', '')) <= 40
                   ),
  price_paise      bigint NOT NULL CHECK (price_paise > 0),
  days_delta       integer NOT NULL DEFAULT 0 CHECK (days_delta BETWEEN -30 AND 30),
  extra_revisions  integer NOT NULL DEFAULT 0 CHECK (extra_revisions BETWEEN 0 AND 5),
  active           boolean NOT NULL DEFAULT true,
  sort             integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS package_addons_package_idx ON package_addons (package_id) WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS set_updated_at ON package_addons;
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON package_addons FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- At most 3 active (not deleted) add-ons per package. The package row is locked
-- first so two concurrent inserts cannot both pass the count.
CREATE OR REPLACE FUNCTION package_addons_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  IF NEW.active AND NEW.deleted_at IS NULL THEN
    PERFORM 1 FROM packages WHERE id = NEW.package_id FOR UPDATE;
    SELECT count(*) INTO n FROM package_addons
     WHERE package_id = NEW.package_id AND active AND deleted_at IS NULL AND id <> NEW.id;
    IF n >= 3 THEN
      RAISE EXCEPTION 'addon_limit: at most 3 active add-ons per package' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS package_addons_limit ON package_addons;
--> statement-breakpoint
CREATE TRIGGER package_addons_limit BEFORE INSERT OR UPDATE ON package_addons FOR EACH ROW EXECUTE FUNCTION package_addons_limit();
--> statement-breakpoint

ALTER TABLE package_addons ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON package_addons FROM anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "package_addons: public read active" ON package_addons;
--> statement-breakpoint
CREATE POLICY "package_addons: public read active" ON package_addons
  FOR SELECT USING (
    active AND deleted_at IS NULL
    AND package_id IN (
      SELECT id FROM packages
       WHERE status = 'active' AND deleted_at IS NULL
         AND provider_id IN (SELECT id FROM provider_profiles WHERE status = 'active' AND deleted_at IS NULL)
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "package_addons: provider read own" ON package_addons;
--> statement-breakpoint
CREATE POLICY "package_addons: provider read own" ON package_addons
  FOR SELECT USING (
    package_id IN (
      SELECT id FROM packages WHERE provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "package_addons: admin read" ON package_addons;
--> statement-breakpoint
CREATE POLICY "package_addons: admin read" ON package_addons
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint

ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS addons jsonb;
--> statement-breakpoint
ALTER TABLE orders ADD COLUMN IF NOT EXISTS addons jsonb;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION checkout_sessions_copy_addons() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.order_id IS NULL AND NEW.order_id IS NOT NULL
     AND NEW.addons IS NOT NULL AND jsonb_typeof(NEW.addons) = 'array' AND jsonb_array_length(NEW.addons) > 0 THEN
    UPDATE orders SET addons = NEW.addons WHERE id = NEW.order_id AND addons IS NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION checkout_sessions_copy_addons() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS checkout_sessions_copy_addons ON checkout_sessions;
--> statement-breakpoint
CREATE TRIGGER checkout_sessions_copy_addons AFTER UPDATE OF order_id ON checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION checkout_sessions_copy_addons();
