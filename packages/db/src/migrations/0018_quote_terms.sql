-- Phase 4a — quote structure: four OPTIONAL commercial terms on quotes.
-- Additive only; every column is nullable so existing rows and flows are
-- untouched. No backfill: NULL means "not stated by the provider", and the
-- buyer UI renders a neutral "not stated — ask before deciding" hint for it.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS gst_included boolean;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS transport_included boolean;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS valid_until date;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS advance_percent integer;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quotes_advance_percent_range'
  ) THEN
    ALTER TABLE quotes ADD CONSTRAINT quotes_advance_percent_range
      CHECK (advance_percent IS NULL OR (advance_percent >= 0 AND advance_percent <= 100));
  END IF;
END $$;
