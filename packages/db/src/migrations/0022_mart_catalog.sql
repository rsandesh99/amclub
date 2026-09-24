-- AMC Mart M0 — catalog, decision log, goods columns (MART_DESIGN.md §4.1–4.3, §4.6).
-- ═══════════════════════════════════════════════════════════════════════════
-- STAGED MIGRATION — DARK BUILD. Do NOT apply to prod during the build.
-- Applies together with the MART_ENABLED=true deploy at the Launch Gate (§8.2),
-- restoring RULES.md rule 2's intent (migrations deploy with their writers).
-- Local / preview: apply normally (bootstrap or run-migration).
-- ═══════════════════════════════════════════════════════════════════════════
-- Additive only (RULES.md rule 1). Every new table is RLS'd from birth (rule 4)
-- and mirrored in rls/policies.sql. product_events + ai_decisions are
-- append-only under the exact quote_events regime (rule 3): BEFORE UPDATE
-- trigger raises, UPDATE/DELETE revoked from client roles, read-only policies.
--
-- Inertness while MART_ENABLED=false (proven by scripts/verify-mart-inert.ts):
--   • provider_profiles.sells_goods defaults false — no services read/write
--     names it; public_providers view is untouched (column list is explicit).
--   • orders/checkout_sessions gain line_items + delivery_snapshot (NULL on
--     every services row). order_safe_view is `o.*` → rebuilt VERBATIM (0020).
--   • materialize_order gains three copied columns whose session values are
--     the defaults for every services session → byte-identical order rows.
--   • payouts gains nullable tds_* columns; runPayouts never reads them.

-- ─── 1. Config tables ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mart_categories (
  slug                text PRIMARY KEY,
  name_i18n           jsonb NOT NULL,
  return_window_hours integer NOT NULL DEFAULT 48,
  commission_bps      integer NOT NULL DEFAULT 500,
  bis_blocked         boolean NOT NULL DEFAULT false,
  is_active           boolean NOT NULL DEFAULT true,
  sort_order          integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz,
  CONSTRAINT mart_categories_window_check CHECK (return_window_hours >= 0),
  CONSTRAINT mart_categories_commission_check CHECK (commission_bps BETWEEN 0 AND 5000)
);
--> statement-breakpoint
-- Launch seed — mirrors MART_CATEGORY_SEED in @amclub/shared. Founder decisions
-- §9.2 (return windows) and §9.3 (commission) are edited HERE, never in code.
INSERT INTO mart_categories (slug, name_i18n, return_window_hours, commission_bps, bis_blocked, sort_order) VALUES
  ('fasteners',           '{"en":"Fasteners","hi":"फास्टनर","te":"ఫాస్టెనర్లు"}', 48, 500, false, 1),
  ('welding-consumables', '{"en":"Welding consumables","hi":"वेल्डिंग सामग्री","te":"వెల్డింగ్ సామగ్రి"}', 48, 500, false, 2),
  ('abrasives',           '{"en":"Abrasives","hi":"अपघर्षक","te":"అబ్రేసివ్స్"}', 48, 500, false, 3),
  ('lubricants',          '{"en":"Oils & lubricants","hi":"तेल और स्नेहक","te":"నూనెలు & లూబ్రికెంట్లు"}', 48, 500, false, 4),
  ('cutting-tools',       '{"en":"Cutting tools","hi":"कटिंग टूल्स","te":"కటింగ్ టూల్స్"}', 48, 500, false, 5),
  ('hand-tools',          '{"en":"Hand tools","hi":"हैंड टूल्स","te":"హ్యాండ్ టూల్స్"}', 48, 500, false, 6),
  ('spares',              '{"en":"Machine spares","hi":"मशीन स्पेयर","te":"మెషిన్ స్పేర్లు"}', 48, 500, false, 7),
  ('safety-gear',         '{"en":"Safety gear","hi":"सुरक्षा उपकरण","te":"భద్రతా సామగ్రి"}', 48, 500, true, 8)
ON CONFLICT (slug) DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mart_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
--> statement-breakpoint
INSERT INTO mart_settings (key, value) VALUES
  -- E-way bill mandatory above ₹50,000 consignment value (§2); fields captured
  -- at dispatch when order total ≥ threshold; generator integration is M3.
  ('eway_bill_threshold_paise', '5000000'),
  -- Catalog Agent doctrine: admin approves the first N listings per seller,
  -- later submissions auto-activate (still audited via product_events).
  ('auto_approve_after_listings', '3'),
  -- TDS on seller vendor payments under MoR (§2) — CA sets these. bps=0 until
  -- the CA confirms section + rate; the payout writer records whatever is here.
  ('tds', '{"section": "194C", "rate_bps": 0, "threshold_paise": 3000000}'),
  -- Launch fulfilment = seller-arranged local delivery / buyer pickup within
  -- the cluster (§3.2); the due date the order carries.
  ('goods_delivery_days', '3')
ON CONFLICT (key) DO NOTHING;

-- ─── 2. Sellers are providers ────────────────────────────────────────────────
--> statement-breakpoint
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS sells_goods boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- 0004 narrowed client SELECT on provider_profiles to a column list; the
-- products/price_tiers public-read policies below read sells_goods, so the
-- new (non-sensitive, public-facing) column joins that list. Caught by
-- killtest-mart-schema: "permission denied for table provider_profiles".
GRANT SELECT (sells_goods) ON public.provider_profiles TO anon, authenticated;

-- ─── 3. Catalog ──────────────────────────────────────────────────────────────
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS products (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id         uuid NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  category_slug     text NOT NULL REFERENCES mart_categories(slug),
  name              text NOT NULL,
  description       text,
  brand             text,
  specs             jsonb NOT NULL DEFAULT '[]',
  -- in_stock | lead_time — seller-declared (no inventory is ever held)
  availability      text NOT NULL DEFAULT 'in_stock',
  lead_time_days    integer,
  -- denormalised min_qty=1 tier price (API-maintained) for sort/filter
  list_price_paise  bigint,
  hsn_code          text NOT NULL,
  gst_rate_bps      integer NOT NULL,
  unit              text NOT NULL,
  images            text[] NOT NULL DEFAULT '{}',
  min_order_qty     integer NOT NULL DEFAULT 1,
  country_of_origin text NOT NULL DEFAULT 'IN',
  status            text NOT NULL DEFAULT 'draft',
  approved_by       uuid REFERENCES users(id),
  approved_at       timestamptz,
  search_tsv        tsvector GENERATED ALWAYS AS (
                      to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(brand, '') || ' ' || coalesce(description, '') || ' ' || coalesce(hsn_code, ''))
                    ) STORED,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz,
  deleted_at        timestamptz,
  CONSTRAINT products_status_check CHECK (status IN ('draft', 'pending_approval', 'active', 'suspended')),
  CONSTRAINT products_gst_rate_check CHECK (gst_rate_bps IN (0, 500, 1200, 1800, 2800)),
  CONSTRAINT products_hsn_check CHECK (hsn_code ~ '^[0-9]{4}([0-9]{2})?([0-9]{2})?$'),
  CONSTRAINT products_min_order_qty_check CHECK (min_order_qty > 0),
  CONSTRAINT products_availability_check CHECK (availability IN ('in_stock', 'lead_time'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS products_seller_idx ON products (seller_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS products_category_status_idx ON products (category_slug, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS products_search_idx ON products USING GIN (search_tsv);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS products_status_price_idx ON products (status, list_price_paise);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS price_tiers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  min_qty          integer NOT NULL,
  unit_price_paise bigint NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz,
  CONSTRAINT price_tiers_product_min_qty_uniq UNIQUE (product_id, min_qty),
  CONSTRAINT price_tiers_min_qty_positive CHECK (min_qty > 0),
  CONSTRAINT price_tiers_price_positive CHECK (unit_price_paise > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS product_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES users(id),
  -- created | edited | submitted | activated | rejected | suspended | price_changed
  event_type text NOT NULL,
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS product_events_product_idx ON product_events (product_id, created_at);
--> statement-breakpoint
-- Append-only regime (reuses raise_append_only() from 0017).
DROP TRIGGER IF EXISTS product_events_no_update ON product_events;
--> statement-breakpoint
CREATE TRIGGER product_events_no_update
  BEFORE UPDATE ON product_events
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON product_events FROM anon, authenticated;

-- ─── 4. ai_decisions (§4.6) ──────────────────────────────────────────────────
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ai_decisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- catalog_draft | payout_dossier | extraction_correction
  feature          text NOT NULL,
  input_refs       jsonb NOT NULL,
  proposed         jsonb NOT NULL,
  final            jsonb NOT NULL,
  corrected_fields text[] NOT NULL DEFAULT '{}',
  decided_by       uuid NOT NULL REFERENCES users(id),
  decided_at       timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_decisions_feature_check CHECK (feature IN ('catalog_draft', 'payout_dossier', 'extraction_correction'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_decisions_feature_idx ON ai_decisions (feature, decided_at);
--> statement-breakpoint
DROP TRIGGER IF EXISTS ai_decisions_no_update ON ai_decisions;
--> statement-breakpoint
CREATE TRIGGER ai_decisions_no_update
  BEFORE UPDATE ON ai_decisions
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON ai_decisions FROM anon, authenticated;

-- ─── 5. Goods columns on the ONE order spine (§4.3) ─────────────────────────
--> statement-breakpoint
ALTER TABLE orders ADD COLUMN IF NOT EXISTS line_items jsonb;
--> statement-breakpoint
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_snapshot jsonb;
--> statement-breakpoint
ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS line_items jsonb;
--> statement-breakpoint
ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS delivery_snapshot jsonb;
--> statement-breakpoint
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS tds_section text;
--> statement-breakpoint
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS tds_bps integer;
--> statement-breakpoint
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS tds_paise bigint;
--> statement-breakpoint
-- order_safe_view is `o.*` — DROP + CREATE verbatim from rls/policies.sql (0020 lesson),
-- including ADR 022's security_invoker + grants (0070), so a re-run stays closed.
DROP VIEW IF EXISTS order_safe_view;
--> statement-breakpoint
CREATE VIEW order_safe_view WITH (security_invoker = true) AS
  SELECT
    o.*,
    CASE
      WHEN o.status = 'placed'
        AND o.provider_id IN (
          SELECT id FROM provider_profiles WHERE user_id = auth.uid()
        )
      THEN NULL
      ELSE (
        SELECT u.phone FROM users u
        JOIN msme_profiles mp ON mp.user_id = u.id
        WHERE mp.id = o.msme_id
      )
    END AS msme_phone
  FROM orders o;
--> statement-breakpoint
REVOKE ALL ON order_safe_view FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON order_safe_view TO authenticated;

-- ─── 6. materialize_order copies kind + goods snapshots ─────────────────────
-- Full restatement of 0003 with EXACTLY three added columns (kind, line_items,
-- delivery_snapshot) copied from the frozen session. For every services
-- session these are ('service', NULL, NULL) — the column defaults — so the
-- resulting order row is byte-identical to 0003's. Idempotency logic untouched.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION materialize_order(
  p_razorpay_order_id   text,
  p_razorpay_payment_id text,
  p_amount_paise        bigint,
  p_method              text,
  p_payload             jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session checkout_sessions%ROWTYPE;
  v_order_id uuid;
BEGIN
  -- (1) Already-processed payment → idempotent no-op.
  SELECT order_id INTO v_order_id FROM payments WHERE razorpay_payment_id = p_razorpay_payment_id;
  IF FOUND THEN
    RETURN v_order_id;
  END IF;

  -- (2) Claim the session (CAS). A racing caller blocks on the row lock, then
  --     finds status <> 'created' and falls through to return the existing order.
  UPDATE checkout_sessions
     SET status = 'materializing', updated_at = now()
   WHERE razorpay_order_id = p_razorpay_order_id
     AND status = 'created'
  RETURNING * INTO v_session;

  IF NOT FOUND THEN
    SELECT order_id INTO v_order_id FROM checkout_sessions WHERE razorpay_order_id = p_razorpay_order_id;
    RETURN v_order_id; -- NULL only if the order_id is unknown; caller logs
  END IF;

  -- Create the order from FROZEN session amounts (never recompute from live pkg).
  INSERT INTO orders (
    msme_id, provider_id, source, package_id, quote_id, title, scope_snapshot,
    price_paise, discount_paise, gst_paise, total_paise,
    commission_bps, commission_paise, provider_earning_paise,
    delivery_days, revision_max, status, due_at,
    kind, line_items, delivery_snapshot
  ) VALUES (
    v_session.msme_id, v_session.provider_id, v_session.source, v_session.package_id,
    v_session.quote_id, v_session.title, v_session.scope_snapshot,
    v_session.price_paise, v_session.discount_paise, v_session.gst_paise, v_session.total_paise,
    v_session.commission_bps, v_session.commission_paise, v_session.provider_earning_paise,
    v_session.delivery_days, v_session.revision_max, 'placed',
    now() + (v_session.delivery_days || ' days')::interval,
    v_session.kind, v_session.line_items, v_session.delivery_snapshot
  )
  RETURNING id INTO v_order_id;

  -- Payment row — unique(razorpay_payment_id), unique(idempotency_key).
  INSERT INTO payments (
    order_id, razorpay_order_id, razorpay_payment_id, amount_paise, method, status,
    webhook_payload, idempotency_key
  ) VALUES (
    v_order_id, p_razorpay_order_id, p_razorpay_payment_id, p_amount_paise, p_method, 'captured',
    p_payload, v_session.idempotency_key
  )
  ON CONFLICT (razorpay_payment_id) DO NOTHING;

  -- Append the 'placed' event (timeline source of truth).
  INSERT INTO order_events (order_id, actor_id, event, payload)
  VALUES (v_order_id, NULL, 'placed', jsonb_build_object('razorpay_payment_id', p_razorpay_payment_id));

  -- Coupon redemption (best-effort; usage limit enforced at checkout).
  IF v_session.coupon_code IS NOT NULL THEN
    INSERT INTO coupon_redemptions (coupon_id, order_id, msme_id)
    SELECT c.id, v_order_id, v_session.msme_id FROM coupons c WHERE c.code = v_session.coupon_code
    ON CONFLICT DO NOTHING;
    UPDATE coupons SET used_count = used_count + 1 WHERE code = v_session.coupon_code;
  END IF;

  -- Mark session done.
  UPDATE checkout_sessions
     SET status = 'materialized', order_id = v_order_id, updated_at = now()
   WHERE id = v_session.id;

  RETURN v_order_id;
END;
$$;

-- ─── 7. RLS (mirrored in rls/policies.sql) ───────────────────────────────────
--> statement-breakpoint
ALTER TABLE mart_categories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mart_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE price_tiers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE product_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_decisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "mart_categories: public read active" ON mart_categories;
--> statement-breakpoint
CREATE POLICY "mart_categories: public read active" ON mart_categories
  FOR SELECT USING (is_active = true);
--> statement-breakpoint
DROP POLICY IF EXISTS "mart_categories: admin all" ON mart_categories;
--> statement-breakpoint
CREATE POLICY "mart_categories: admin all" ON mart_categories
  FOR ALL USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
DROP POLICY IF EXISTS "mart_settings: admin read" ON mart_settings;
--> statement-breakpoint
CREATE POLICY "mart_settings: admin read" ON mart_settings
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON mart_settings FROM anon, authenticated;
--> statement-breakpoint
-- products: public sees ACTIVE listings of ACTIVE sellers only; sellers own theirs.
DROP POLICY IF EXISTS "products: public read active" ON products;
--> statement-breakpoint
CREATE POLICY "products: public read active" ON products
  FOR SELECT USING (
    status = 'active' AND deleted_at IS NULL
    AND seller_id IN (SELECT id FROM provider_profiles WHERE status = 'active' AND deleted_at IS NULL AND sells_goods = true)
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "products: seller crud own" ON products;
--> statement-breakpoint
CREATE POLICY "products: seller crud own" ON products
  FOR ALL
  USING (seller_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()))
  WITH CHECK (seller_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));
--> statement-breakpoint
DROP POLICY IF EXISTS "products: admin all" ON products;
--> statement-breakpoint
CREATE POLICY "products: admin all" ON products
  FOR ALL USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
DROP POLICY IF EXISTS "price_tiers: public read active" ON price_tiers;
--> statement-breakpoint
CREATE POLICY "price_tiers: public read active" ON price_tiers
  FOR SELECT USING (
    product_id IN (
      SELECT p.id FROM products p
      JOIN provider_profiles s ON s.id = p.seller_id
      WHERE p.status = 'active' AND p.deleted_at IS NULL
        AND s.status = 'active' AND s.deleted_at IS NULL AND s.sells_goods = true
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "price_tiers: seller crud own" ON price_tiers;
--> statement-breakpoint
CREATE POLICY "price_tiers: seller crud own" ON price_tiers
  FOR ALL
  USING (product_id IN (SELECT id FROM products WHERE seller_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())))
  WITH CHECK (product_id IN (SELECT id FROM products WHERE seller_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())));
--> statement-breakpoint
DROP POLICY IF EXISTS "price_tiers: admin all" ON price_tiers;
--> statement-breakpoint
CREATE POLICY "price_tiers: admin all" ON price_tiers
  FOR ALL USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
-- product_events: read-only for every client role (service role writes).
DROP POLICY IF EXISTS "product_events: seller read own" ON product_events;
--> statement-breakpoint
CREATE POLICY "product_events: seller read own" ON product_events
  FOR SELECT USING (
    product_id IN (SELECT id FROM products WHERE seller_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()))
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "product_events: admin read" ON product_events;
--> statement-breakpoint
CREATE POLICY "product_events: admin read" ON product_events
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT ON product_events FROM anon, authenticated;
--> statement-breakpoint
-- ai_decisions: the deciding human may read their own rows; admins read all; service role writes.
DROP POLICY IF EXISTS "ai_decisions: self read" ON ai_decisions;
--> statement-breakpoint
CREATE POLICY "ai_decisions: self read" ON ai_decisions
  FOR SELECT USING (decided_by = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "ai_decisions: admin read" ON ai_decisions;
--> statement-breakpoint
CREATE POLICY "ai_decisions: admin read" ON ai_decisions
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT ON ai_decisions FROM anon, authenticated;
