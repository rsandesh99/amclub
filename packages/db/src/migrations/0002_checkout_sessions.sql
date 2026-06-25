-- Phase 4 — checkout intents + tax readiness.
--
-- checkout_sessions: the order's frozen amounts + scope are locked HERE at
-- checkout time (when the buyer agreed to the price). The Razorpay webhook
-- MATERIALISES the order from this row — checkout itself never creates an order
-- (§2.5 rule: webhook is the single source of truth). Keyed by razorpay_order_id.

CREATE TABLE IF NOT EXISTS "checkout_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "razorpay_order_id" text UNIQUE,
  "msme_id" uuid NOT NULL REFERENCES "msme_profiles"("id"),
  "provider_id" uuid NOT NULL REFERENCES "provider_profiles"("id"),
  "source" text NOT NULL,                       -- 'package' | 'quote'
  "package_id" uuid REFERENCES "packages"("id"),
  "quote_id" uuid REFERENCES "quotes"("id"),
  "title" text NOT NULL,
  "scope_snapshot" jsonb NOT NULL,              -- IMMUTABLE copy frozen at checkout
  "price_paise" bigint NOT NULL,
  "discount_paise" bigint DEFAULT 0 NOT NULL,
  "gst_paise" bigint NOT NULL,
  "total_paise" bigint NOT NULL,
  "commission_bps" integer NOT NULL,            -- frozen from category at checkout
  "commission_paise" bigint NOT NULL,
  "provider_earning_paise" bigint NOT NULL,
  "delivery_days" integer NOT NULL,
  "revision_max" integer,
  "coupon_code" text,
  "gst_invoice" jsonb,                          -- buyer GSTIN / business details (optional)
  "idempotency_key" text UNIQUE NOT NULL,       -- dedupes double checkout submits
  "status" text DEFAULT 'created' NOT NULL,     -- created | materialized | failed | expired
  "order_id" uuid REFERENCES "orders"("id"),
  "expires_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checkout_sessions_rzp_order_idx" ON "checkout_sessions" ("razorpay_order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checkout_sessions_msme_idx" ON "checkout_sessions" ("msme_id");
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "checkout_sessions"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- §9.1: build tcs_paise (TCS under GST Sec 52) column readiness into payments.
-- Defer the actual TCS computation to a pre-live compliance task; default 0 now.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "tcs_paise" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- RLS: a buyer manages their own checkout sessions; service-role (webhook) and
-- admins bypass via existing patterns. Reads are owner-only (contains amounts).
ALTER TABLE "checkout_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "checkout_sessions: owner all" ON checkout_sessions;
CREATE POLICY "checkout_sessions: owner all" ON checkout_sessions
  FOR ALL
  USING (msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth.uid()))
  WITH CHECK (msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth.uid()));
