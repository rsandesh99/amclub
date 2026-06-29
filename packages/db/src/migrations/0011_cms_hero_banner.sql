-- Phase 6 polish — extend cms_banners to support text/hero banners (A6).
-- The original table was image-only; the investor-demo hero needs editable copy
-- (headline/subline/CTA), an editable discount figure, and a CTA href — all
-- authored from /admin/cms with NO code change. Idempotent: safe to re-run.
--
-- RLS unchanged: the existing "cms_banners: public read active" policy is
-- row-level, so the new columns are already publicly readable on active rows.

ALTER TABLE cms_banners
  ADD COLUMN IF NOT EXISTS variant      text NOT NULL DEFAULT 'image',  -- 'image' | 'hero'
  ADD COLUMN IF NOT EXISTS headline     jsonb,        -- { en, hi }
  ADD COLUMN IF NOT EXISTS subline      jsonb,        -- { en, hi }
  ADD COLUMN IF NOT EXISTS cta_label    jsonb,        -- { en, hi }
  ADD COLUMN IF NOT EXISTS cta_href     text,
  ADD COLUMN IF NOT EXISTS discount_pct integer;      -- editable, must stay backable by a real listing

-- Hero banners carry no image; only image-variant banners require image_url.
ALTER TABLE cms_banners ALTER COLUMN image_url DROP NOT NULL;

-- Guard: image banners must have an image; hero banners must have a headline.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cms_banners_variant_shape'
  ) THEN
    ALTER TABLE cms_banners ADD CONSTRAINT cms_banners_variant_shape CHECK (
      (variant = 'image' AND image_url IS NOT NULL)
      OR (variant = 'hero' AND headline IS NOT NULL)
    );
  END IF;
END $$;
