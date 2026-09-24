-- 0075 — Client read narrowing (architecture + security audit, 2026-09-24: M10, M17).
-- No data changes. Every reader these statements touch is a /api/v1 route on the
-- service role, so nothing in the product loses a read.
--
-- M17: rfq_clarifications is readable by the buyer and every matched provider (the
--      thread is shared on purpose), but provider_id (who asked) and answered_by (the
--      buyer's user id) were readable too, so a competitor learned who asked what.
--      Clients keep SELECT on every other column; the API already hides both.
-- M10: every active coupon code was listable with the anon key ("public read active").
--      Checkout now reads the coupon with the service role, like the validate route.

REVOKE SELECT ON rfq_clarifications FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT (id, rfq_id, question, question_redacted, answer, answer_redacted, asked_at, answered_at, created_at, updated_at, deleted_at)
  ON rfq_clarifications TO authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "coupons: public read active" ON coupons;
--> statement-breakpoint
REVOKE SELECT ON coupons FROM anon, authenticated;
