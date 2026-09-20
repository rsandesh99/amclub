-- Buyer decline + compare pointers (BUILD_PROMPTS S1.2) — additive, idempotent,
-- NOT staged (apply to prod before/with the writer, RULES.md 2).
--
-- quotes.decline_*: the first buyer-initiated quotes.status write records WHY
-- (reason), the buyer's private words (decline_note — hidden from every client
-- role by column privileges, exactly as provider_profiles hides PAN/GSTIN; the
-- buyer sees it through /api/v1 with the service role), the courteous message
-- that was delivered (+ its locale), who declined (buyer | system) and when,
-- and the ai_decisions row when the decline_message agent wrote the text.
-- finalizeQuoteAcceptance (system) now also stamps another_quote_accepted.
--
-- rfqs.compare_pointers: a one-slot cache { hash, locale, pointers, model,
-- stub, created_at } for the compare_pointers agent; recomputed when the hash
-- (sorted quote ids + updated_at + locale) changes.

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS decline_reason text;
--> statement-breakpoint
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_decline_reason_check;
--> statement-breakpoint
ALTER TABLE quotes ADD CONSTRAINT quotes_decline_reason_check
  CHECK (decline_reason IS NULL OR decline_reason IN ('price_high', 'delivery_slow', 'details_unclear', 'terms_unacceptable', 'chose_other', 'other', 'another_quote_accepted'));
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS decline_note text;
--> statement-breakpoint
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_decline_note_len;
--> statement-breakpoint
ALTER TABLE quotes ADD CONSTRAINT quotes_decline_note_len CHECK (decline_note IS NULL OR char_length(decline_note) <= 200);
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS decline_message text;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS decline_message_locale text;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS declined_by text;
--> statement-breakpoint
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_declined_by_check;
--> statement-breakpoint
ALTER TABLE quotes ADD CONSTRAINT quotes_declined_by_check CHECK (declined_by IS NULL OR declined_by IN ('buyer', 'system'));
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS declined_at timestamptz;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS decline_decision_id uuid REFERENCES ai_decisions(id);
--> statement-breakpoint

ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS compare_pointers jsonb;
--> statement-breakpoint
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS compare_pointers_at timestamptz;
--> statement-breakpoint

-- Column privileges: hide decline_note from every client role. RLS stays as is
-- (row policies); the fixed column list below excludes decline_note. The
-- staged Mart goods columns (0024) are granted only where they exist.
REVOKE SELECT ON quotes FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT (
  id, rfq_id, provider_id, price_paise, delivery_days, scope, message,
  gst_included, transport_included, valid_until, advance_percent,
  status, created_at, updated_at,
  extraction_id, extraction_confirmed_at,
  decline_reason, decline_message, decline_message_locale, declined_by, declined_at, decline_decision_id
) ON quotes TO anon, authenticated;
--> statement-breakpoint
DO $goods$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'quotes' AND column_name = 'unit_price_paise') THEN
    EXECUTE 'GRANT SELECT (unit_price_paise, qty, gst_rate_bps, hsn_code, product_id) ON quotes TO anon, authenticated';
  END IF;
END
$goods$;
