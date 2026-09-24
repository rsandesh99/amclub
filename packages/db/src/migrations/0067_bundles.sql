-- Experience v3 E12c (N18) — compliance bundles with milestone escrow (ADR 021).
-- Money; dark behind agent_settings.bundles_enabled (default off). Depends on
-- 0064 (ADR 018): the plan is frozen on a checkout session no client can write.
--
--   bundle_milestones     a package is a bundle when it has 2..6 milestones
--                         (seq, label, due offset ≤ 92 days, share in bps; the
--                         shares sum to 10,000 — shared bundleMilestonesSchema,
--                         enforced by the only writer, the partner route).
--                         Public reads a bundle's milestones like its package;
--                         the provider reads their own; no client writes.
--   bundle_purchases      one row per paid bundle: the buyer, provider,
--                         package, the ONE payment. Buyer / provider read own.
--   orders.bundle_purchase_id / bundle_seq / available_at
--                         each milestone is an ordinary child order; later
--                         children become actionable at available_at.
--   checkout_sessions.bundle_plan
--                         the per-child amounts, computed ONCE at checkout by
--                         shared bundlePlan (each column sums exactly to the
--                         whole; the last child takes the paise remainder).
--   checkout_sessions_materialize_bundle
--                         in the same transaction that links the session to
--                         its order (materialize_order sets order_id), turns
--                         that order into child 1 and inserts children 2..N
--                         from the FROZEN plan (copies, never recomputes). Fires
--                         only when order_id is first set, so a replayed webhook
--                         creates nothing. Neither materialize_order version
--                         (0003 / staged 0022) is redefined.
--
-- Backfill: none (every existing order has bundle_purchase_id NULL).
-- Rollback (after bundles_enabled is off and no open bundle remains):
--   DROP TRIGGER checkout_sessions_materialize_bundle ON checkout_sessions;
--   DROP FUNCTION checkout_sessions_materialize_bundle();
--   ALTER TABLE orders DROP COLUMN bundle_purchase_id, DROP COLUMN bundle_seq,
--     DROP COLUMN available_at; ALTER TABLE checkout_sessions DROP COLUMN bundle_plan;
--   DROP TABLE bundle_purchases; DROP TABLE bundle_milestones;

CREATE TABLE IF NOT EXISTS bundle_milestones (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id       uuid NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  seq              integer NOT NULL CHECK (seq BETWEEN 1 AND 6),
  label_i18n       jsonb NOT NULL CHECK (jsonb_typeof(label_i18n) = 'object' AND char_length(coalesce(label_i18n->>'en', '')) BETWEEN 1 AND 60),
  due_offset_days  integer NOT NULL CHECK (due_offset_days BETWEEN 1 AND 92),
  share_bps        integer NOT NULL CHECK (share_bps BETWEEN 100 AND 10000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (package_id, seq)
);
--> statement-breakpoint
ALTER TABLE bundle_milestones ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON bundle_milestones FROM anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "bundle_milestones: public read" ON bundle_milestones;
--> statement-breakpoint
CREATE POLICY "bundle_milestones: public read" ON bundle_milestones
  FOR SELECT USING (
    package_id IN (
      SELECT id FROM packages
       WHERE status = 'active' AND deleted_at IS NULL
         AND provider_id IN (SELECT id FROM provider_profiles WHERE status = 'active' AND deleted_at IS NULL)
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "bundle_milestones: provider read own" ON bundle_milestones;
--> statement-breakpoint
CREATE POLICY "bundle_milestones: provider read own" ON bundle_milestones
  FOR SELECT USING (
    package_id IN (SELECT id FROM packages WHERE provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()))
  );
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS bundle_purchases (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  msme_id              uuid NOT NULL REFERENCES msme_profiles(id),
  provider_id          uuid NOT NULL REFERENCES provider_profiles(id),
  package_id           uuid REFERENCES packages(id) ON DELETE SET NULL,
  checkout_session_id  uuid NOT NULL UNIQUE REFERENCES checkout_sessions(id),
  payment_id           uuid REFERENCES payments(id),
  total_paise          bigint NOT NULL CHECK (total_paise > 0),
  title                text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bundle_purchases_msme_idx ON bundle_purchases (msme_id);
--> statement-breakpoint
ALTER TABLE bundle_purchases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON bundle_purchases FROM anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "bundle_purchases: parties read" ON bundle_purchases;
--> statement-breakpoint
CREATE POLICY "bundle_purchases: parties read" ON bundle_purchases
  FOR SELECT USING (
    msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
    OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
  );
--> statement-breakpoint

ALTER TABLE orders ADD COLUMN IF NOT EXISTS bundle_purchase_id uuid REFERENCES bundle_purchases(id);
--> statement-breakpoint
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bundle_seq integer;
--> statement-breakpoint
ALTER TABLE orders ADD COLUMN IF NOT EXISTS available_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS orders_bundle_purchase_idx ON orders (bundle_purchase_id) WHERE bundle_purchase_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS bundle_plan jsonb;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION checkout_sessions_materialize_bundle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_carrier   orders%ROWTYPE;
  v_purchase  uuid;
  v_payment   uuid;
  v_child     jsonb;
  v_seq       integer;
  v_now       timestamptz := now();
  v_avail     timestamptz;
  v_new       uuid;
BEGIN
  IF OLD.order_id IS NOT NULL OR NEW.order_id IS NULL OR NEW.bundle_plan IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_carrier FROM orders WHERE id = NEW.order_id;
  IF NOT FOUND OR v_carrier.bundle_purchase_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT id INTO v_payment FROM payments WHERE order_id = NEW.order_id LIMIT 1;

  INSERT INTO bundle_purchases (msme_id, provider_id, package_id, checkout_session_id, payment_id, total_paise, title)
  VALUES (NEW.msme_id, NEW.provider_id, NEW.package_id, NEW.id, v_payment, NEW.total_paise, NEW.title)
  RETURNING id INTO v_purchase;

  FOR v_child IN SELECT * FROM jsonb_array_elements(NEW.bundle_plan->'children') LOOP
    v_seq := (v_child->>'seq')::integer;
    v_avail := v_now + ((v_child->>'startsOffsetDays')::integer || ' days')::interval;
    IF v_seq = 1 THEN
      -- The materialized order becomes child 1 (its share; the payment row stays on it).
      UPDATE orders SET
        price_paise            = (v_child->'amounts'->>'pricePaise')::bigint,
        discount_paise         = (v_child->'amounts'->>'discountPaise')::bigint,
        gst_paise              = (v_child->'amounts'->>'gstPaise')::bigint,
        total_paise            = (v_child->'amounts'->>'totalPaise')::bigint,
        commission_paise       = (v_child->'amounts'->>'commissionPaise')::bigint,
        provider_earning_paise = (v_child->'amounts'->>'providerEarningPaise')::bigint,
        delivery_days          = (v_child->>'deliveryDays')::integer,
        due_at                 = v_avail + ((v_child->>'deliveryDays')::integer || ' days')::interval,
        title                  = left(v_carrier.title || ' — ' || (v_child->'label'->>'en'), 300),
        bundle_purchase_id     = v_purchase,
        bundle_seq             = 1,
        available_at           = v_avail,
        updated_at             = v_now
      WHERE id = v_carrier.id;
    ELSE
      INSERT INTO orders (
        msme_id, provider_id, source, package_id, quote_id, title, scope_snapshot,
        price_paise, discount_paise, gst_paise, total_paise,
        commission_bps, commission_paise, provider_earning_paise,
        delivery_days, revision_max, status, due_at,
        bundle_purchase_id, bundle_seq, available_at
      ) VALUES (
        v_carrier.msme_id, v_carrier.provider_id, v_carrier.source, v_carrier.package_id, NULL,
        left(v_carrier.title || ' — ' || (v_child->'label'->>'en'), 300), v_carrier.scope_snapshot,
        (v_child->'amounts'->>'pricePaise')::bigint, (v_child->'amounts'->>'discountPaise')::bigint,
        (v_child->'amounts'->>'gstPaise')::bigint, (v_child->'amounts'->>'totalPaise')::bigint,
        v_carrier.commission_bps, (v_child->'amounts'->>'commissionPaise')::bigint, (v_child->'amounts'->>'providerEarningPaise')::bigint,
        (v_child->>'deliveryDays')::integer, v_carrier.revision_max, 'placed',
        v_avail + ((v_child->>'deliveryDays')::integer || ' days')::interval,
        v_purchase, v_seq, v_avail
      ) RETURNING id INTO v_new;
      INSERT INTO order_events (order_id, actor_id, event, payload)
      VALUES (v_new, NULL, 'placed', jsonb_build_object('bundle_purchase_id', v_purchase, 'seq', v_seq));
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION checkout_sessions_materialize_bundle() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS checkout_sessions_materialize_bundle ON checkout_sessions;
--> statement-breakpoint
CREATE TRIGGER checkout_sessions_materialize_bundle AFTER UPDATE OF order_id ON checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION checkout_sessions_materialize_bundle();
