-- Security hotfix — money and order-state rows are server-written only (ADR 018).
--
-- Before (found 2026-09-23 while reading checkout for E12a):
--   * materialize_order() is SECURITY DEFINER and kept the default EXECUTE for
--     PUBLIC / anon / authenticated. A buyer who got a razorpay_order_id back
--     from POST /api/v1/checkout could call /rest/v1/rpc/materialize_order with
--     a made-up payment id and amount and get a 'placed' order + a 'captured'
--     payment row without paying.
--   * Client roles kept the default table-wide INSERT / UPDATE / DELETE grants
--     on the money and state tables; only row policies stood in the way, and
--     several are FOR ALL on the party's own rows ("orders: provider all own",
--     "orders: msme all own", "checkout_sessions: owner all", "disputes:
--     parties all", "rfqs: owner all", "quotes: provider crud own", …). So a
--     provider could PATCH their own order to status 'completed' and raise
--     provider_earning_paise; a buyer could rewrite a checkout session's
--     provider / commission / earning split (materialize_order copies it) or
--     plant a session under a known idempotency key; a party could rewrite a
--     dispute; a provider could change any column of a review about them.
--
-- After: EXECUTE on materialize_order (and the three admin-only helpers
-- claim_quote_slot / release_quote_slot / increment_coupon_usage) is the
-- service role's only; client roles hold no INSERT / UPDATE / DELETE on the
-- tables below. Reads are unchanged (the existing SELECT policies still apply).
-- Every legitimate writer already uses the service role (audited 2026-09-23:
-- every .from(<table>).insert/update/upsert/delete in apps/web + apps/mobile),
-- except three routes this change moves to the service role in the same PR:
--   checkout_sessions — api/v1/checkout, api/v1/mart/checkout (session upsert +
--                       razorpay_order_id bind; the route authorises the buyer)
--   reviews           — api/v1/orders/[id]/review (the route now checks the
--                       caller is the order's buyer and it is completed)
-- CREATE OR REPLACE keeps a function's ACL, so the staged Mart 0022
-- materialize_order (same signature) inherits the revoke.
--
-- Rollback (reopens the holes — not recommended): GRANT EXECUTE ON FUNCTION
-- materialize_order(text, text, bigint, text, jsonb) TO anon, authenticated;
-- GRANT INSERT, UPDATE, DELETE ON <table> TO anon, authenticated; for each
-- table below. No data is touched.

-- ─── functions: service role only ────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION materialize_order(text, text, bigint, text, jsonb) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION materialize_order(text, text, bigint, text, jsonb) TO service_role;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION claim_quote_slot(uuid) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_quote_slot(uuid) TO service_role;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION release_quote_slot(uuid) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION release_quote_slot(uuid) TO service_role;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION increment_coupon_usage(uuid) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION increment_coupon_usage(uuid) TO service_role;
--> statement-breakpoint

-- ─── tables: no client writes ────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE ON orders FROM anon, authenticated;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON checkout_sessions FROM anon, authenticated;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON payments FROM anon, authenticated;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON payouts FROM anon, authenticated;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON refunds FROM anon, authenticated;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON invoices FROM anon, authenticated;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON disputes FROM anon, authenticated;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON order_documents FROM anon, authenticated;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON rfqs FROM anon, authenticated;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON quotes FROM anon, authenticated;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON rfq_matches FROM anon, authenticated;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON coupons FROM anon, authenticated;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON coupon_redemptions FROM anon, authenticated;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON provider_bank_accounts FROM anon, authenticated;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON reviews FROM anon, authenticated;
