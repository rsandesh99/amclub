-- AMC Mart M2 — goods RFQ on the existing RFQ + quote spine (MART_DESIGN.md §7 M2).
-- ═══════════════════════════════════════════════════════════════════════════
-- STAGED MIGRATION — DARK BUILD. Do NOT apply to prod during the build.
-- Applies together with the MART_ENABLED=true deploy at the Launch Gate (§8.2),
-- after 0022/0023. Local / preview: apply normally (bootstrap or run-migration).
-- ═══════════════════════════════════════════════════════════════════════════
-- Additive only; no new tables. rfqs and quotes gain nullable goods columns
-- with defaults that leave every services row byte-identical
-- (kind='service', goods columns NULL). category_id becomes nullable ONLY for
-- kind='goods' (CHECK) — services RFQs keep their category exactly as before.
-- RLS: unchanged (the existing rfqs / quotes policies key on ownership and
-- rfq_matches, neither of which changes). Inertness proven by
-- killtest-mart-schema (§5 goods RFQ) + verify-mart-inert.

-- ─── 1. rfqs ─────────────────────────────────────────────────────────────────
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'service';
--> statement-breakpoint
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS mart_category_slug text REFERENCES mart_categories(slug);
--> statement-breakpoint
-- { item, qty, unit, spec[], brand_preference, target_unit_price_paise, delivery{…}, product_id }
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS goods_spec jsonb;
--> statement-breakpoint
ALTER TABLE rfqs ALTER COLUMN category_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE rfqs DROP CONSTRAINT IF EXISTS rfqs_kind_check;
--> statement-breakpoint
ALTER TABLE rfqs ADD CONSTRAINT rfqs_kind_check CHECK (kind IN ('service', 'goods'));
--> statement-breakpoint
ALTER TABLE rfqs DROP CONSTRAINT IF EXISTS rfqs_kind_shape_check;
--> statement-breakpoint
-- The two shapes are mutually exclusive: a services RFQ has its services
-- category and NO Mart columns; a goods RFQ has a Mart category + spec and NO
-- services category (so no services query can ever pick a goods row up by
-- category_id, and no goods query a services row by mart_category_slug).
ALTER TABLE rfqs ADD CONSTRAINT rfqs_kind_shape_check CHECK (
  (kind = 'service' AND category_id IS NOT NULL AND mart_category_slug IS NULL AND goods_spec IS NULL)
  OR (kind = 'goods' AND category_id IS NULL AND mart_category_slug IS NOT NULL AND goods_spec IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rfqs_kind_mart_category_idx ON rfqs (kind, mart_category_slug, status);

-- ─── 2. quotes (goods terms; price_paise stays the total taxable value) ──────
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS unit_price_paise bigint;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS qty integer;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS gst_rate_bps integer;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS hsn_code text;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_goods_terms_check;
--> statement-breakpoint
-- Either no goods terms at all (services) or a complete, consistent set.
ALTER TABLE quotes ADD CONSTRAINT quotes_goods_terms_check CHECK (
  (unit_price_paise IS NULL AND qty IS NULL AND gst_rate_bps IS NULL AND hsn_code IS NULL)
  OR (unit_price_paise IS NOT NULL AND qty IS NOT NULL AND gst_rate_bps IS NOT NULL AND hsn_code IS NOT NULL
      AND unit_price_paise > 0 AND qty > 0 AND gst_rate_bps IN (0, 500, 1200, 1800, 2800)
      AND hsn_code ~ '^[0-9]{4}([0-9]{2})?([0-9]{2})?$' AND price_paise = unit_price_paise * qty)
);
-- (Explicit IS NOT NULL on every term: a CHECK that evaluates to NULL passes,
-- so "unit price only" would otherwise slip through — killtest-mart-goods-rfq.)
