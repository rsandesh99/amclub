-- AMC Mart storefront v2 (PRD Experience v3 E16: N39–N44). STAGED with 0022–0025:
-- NEVER apply to production during the build — it deploys with the
-- MART_ENABLED=true release (Launch Gate, docs/mart/LAUNCH_RUNBOOK.md §3).
-- Only Mart tables change; no services table gains a column, so nothing in the
-- services path can name one of these (mart:static stays green).
--
--   N40  mart_category_attributes   typed attributes per category (text / number /
--                                   enum / bool, unit, options, facetable, required);
--                                   public read, no client writes (config — admin).
--        products.attributes         { key: value } validated per category (shared
--                                   validateProductAttributes) by the seller routes.
--   N41  products.promises          seller opt-in: ships_48h, return_shipping_covered,
--                                   gst_invoice_24h.
--        mart_promise_breaches      one row per measured breach (from the dispatch /
--                                   delivery photo timestamps); service role only.
--   N42  products.sample_price_paise a sample = an ordinary goods order of qty 1 at
--                                   this price (NULL = no samples).
--   N43  mart_categories.returnable / itc_eligible
--                                   config per category ("Not returnable"; the CA-
--                                   reviewed §17(5) flag — ITC shown only for eligible
--                                   lines, computed on the server).
--   N44  mart_reorder_reminders     the buyer's opt-in reminder at their usual interval;
--                                   owner reads, writes via the API.
--
-- Rollback (staged — before the Launch Gate nothing to roll back): DROP TABLE
--   mart_reorder_reminders, mart_promise_breaches, mart_category_attributes;
--   ALTER TABLE products DROP COLUMN attributes, DROP COLUMN promises,
--   DROP COLUMN sample_price_paise; ALTER TABLE mart_categories DROP COLUMN
--   returnable, DROP COLUMN itc_eligible;

CREATE TABLE IF NOT EXISTS mart_category_attributes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_slug  text NOT NULL REFERENCES mart_categories(slug) ON DELETE CASCADE,
  key            text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,31}$'),
  label_i18n     jsonb NOT NULL CHECK (jsonb_typeof(label_i18n) = 'object' AND char_length(coalesce(label_i18n->>'en', '')) BETWEEN 1 AND 40),
  type           text NOT NULL CHECK (type IN ('text', 'number', 'enum', 'bool')),
  unit           text CHECK (unit IS NULL OR char_length(unit) <= 12),
  options        jsonb CHECK (options IS NULL OR jsonb_typeof(options) = 'array'),
  facetable      boolean NOT NULL DEFAULT false,
  required       boolean NOT NULL DEFAULT false,
  sort           integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_slug, key),
  CHECK (type = 'enum' OR options IS NULL),
  CHECK (NOT facetable OR type IN ('enum', 'bool'))
);
--> statement-breakpoint
ALTER TABLE mart_category_attributes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON mart_category_attributes FROM anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "mart_category_attributes: public read" ON mart_category_attributes;
--> statement-breakpoint
CREATE POLICY "mart_category_attributes: public read" ON mart_category_attributes FOR SELECT USING (true);
--> statement-breakpoint

ALTER TABLE products ADD COLUMN IF NOT EXISTS attributes jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS products_attributes_gin ON products USING gin (attributes);
--> statement-breakpoint
ALTER TABLE products ADD COLUMN IF NOT EXISTS promises text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_promises_check;
--> statement-breakpoint
ALTER TABLE products ADD CONSTRAINT products_promises_check CHECK (promises <@ ARRAY['ships_48h', 'return_shipping_covered', 'gst_invoice_24h']::text[]);
--> statement-breakpoint
ALTER TABLE products ADD COLUMN IF NOT EXISTS sample_price_paise bigint CHECK (sample_price_paise IS NULL OR sample_price_paise > 0);
--> statement-breakpoint

ALTER TABLE mart_categories ADD COLUMN IF NOT EXISTS returnable boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE mart_categories ADD COLUMN IF NOT EXISTS itc_eligible boolean NOT NULL DEFAULT true;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS mart_promise_breaches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   uuid REFERENCES products(id) ON DELETE SET NULL,
  seller_id    uuid NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  promise      text NOT NULL CHECK (promise IN ('ships_48h', 'return_shipping_covered', 'gst_invoice_24h')),
  measured_at  timestamptz NOT NULL DEFAULT now(),
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (order_id, product_id, promise)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mart_promise_breaches_product_idx ON mart_promise_breaches (product_id, promise, measured_at);
--> statement-breakpoint
ALTER TABLE mart_promise_breaches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON mart_promise_breaches FROM anon, authenticated;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS mart_reorder_reminders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  interval_days  integer NOT NULL CHECK (interval_days BETWEEN 7 AND 365),
  next_at        timestamptz NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id)
);
--> statement-breakpoint
ALTER TABLE mart_reorder_reminders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON mart_reorder_reminders FROM anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "mart_reorder_reminders: owner read" ON mart_reorder_reminders;
--> statement-breakpoint
CREATE POLICY "mart_reorder_reminders: owner read" ON mart_reorder_reminders FOR SELECT USING (user_id = auth_user_id());
--> statement-breakpoint

-- Seed: typed attributes for two launch categories (config — edited later by admins).
INSERT INTO mart_category_attributes (category_slug, key, label_i18n, type, unit, options, facetable, required, sort) VALUES
  ('fasteners', 'material', '{"en":"Material","hi":"सामग्री"}', 'enum', NULL, '["MS","SS 304","SS 316","Brass","High tensile"]', true, true, 1),
  ('fasteners', 'thread', '{"en":"Thread","hi":"थ्रेड"}', 'enum', NULL, '["Metric","BSW","UNC","UNF"]', true, false, 2),
  ('fasteners', 'diameter_mm', '{"en":"Diameter","hi":"व्यास"}', 'number', 'mm', NULL, false, false, 3),
  ('fasteners', 'length_mm', '{"en":"Length","hi":"लंबाई"}', 'number', 'mm', NULL, false, false, 4),
  ('fasteners', 'zinc_plated', '{"en":"Zinc plated","hi":"ज़िंक प्लेटेड"}', 'bool', NULL, NULL, true, false, 5),
  ('lubricants', 'grade', '{"en":"Grade","hi":"ग्रेड"}', 'enum', NULL, '["ISO VG 32","ISO VG 46","ISO VG 68","EP 2","SAE 20W-40"]', true, true, 1),
  ('lubricants', 'pack_litres', '{"en":"Pack size","hi":"पैक आकार"}', 'number', 'L', NULL, false, false, 2)
ON CONFLICT (category_slug, key) DO NOTHING;
