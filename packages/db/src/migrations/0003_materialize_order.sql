-- Phase 4 — atomic, idempotent order materialisation.
--
-- THE kill-test foundation. Called by BOTH the Razorpay webhook and the
-- reconciliation cron (one code path for normal + dropped-webhook recovery).
--
-- Idempotency is enforced by the DATABASE, not check-then-insert:
--   1. If a payment with this razorpay_payment_id already exists → return its
--      order (no-op).
--   2. Compare-and-swap claim on the checkout_session (created → materializing):
--      only ONE concurrent caller wins; Postgres row-locking makes a racing
--      replay BLOCK until the winner commits, then see 'materializing' and
--      return the already-created order. No duplicate order, ever.
-- The whole function is one transaction — any error rolls back atomically.

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
    delivery_days, revision_max, status, due_at
  ) VALUES (
    v_session.msme_id, v_session.provider_id, v_session.source, v_session.package_id,
    v_session.quote_id, v_session.title, v_session.scope_snapshot,
    v_session.price_paise, v_session.discount_paise, v_session.gst_paise, v_session.total_paise,
    v_session.commission_bps, v_session.commission_paise, v_session.provider_earning_paise,
    v_session.delivery_days, v_session.revision_max, 'placed',
    now() + (v_session.delivery_days || ' days')::interval
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
