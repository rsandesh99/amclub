-- 0078 — Payment truth at capture time (ADR 027; architecture + security audit
-- 2026-09-24: M21 and M39 part 2). NOT staged: every writer is the capture path
-- (webhook, reconcile cron, simulate route), which calls capture_payment() once
-- this is applied. Apply BEFORE the code that calls capture_payment deploys.
--
--   capture_exceptions   a captured payment that created NO order: its checkout
--                        session had expired (expires_at + a grace period, or a
--                        session already closed without an order), or the
--                        session had already been paid by ANOTHER payment (a
--                        second capture on one Razorpay order). The money is
--                        recorded here, never as an order, and refunded in full
--                        (the key `refund_key` is the gateway receipt, so a retry
--                        finds the refund instead of making a second one).
--   capture_payment()    the ONE capture entry point. Replay-safe: a payment
--                        already recorded (as an order's payment or as an
--                        exception) returns the same answer and writes nothing.
--                        It locks the session row, so two captures on one
--                        Razorpay order serialise; a live session goes through
--                        materialize_order() unchanged (either version: 0003 or
--                        the staged Mart 0022 one — this migration does not
--                        redefine it).
--
-- Grants: capture_exceptions and capture_payment() are service-role only (ADR 018 /
-- ADR 025: money rows are server-written; no client role reads or writes them).
--
-- Backfill: none (new table; existing sessions are untouched).
-- Rollback: point the capture path back at materialize_order (revert the code), then
--   DROP FUNCTION capture_payment(text, text, bigint, text, jsonb, integer);
--   DROP TABLE capture_exceptions;  (after exporting any rows ops still needs)

CREATE TABLE IF NOT EXISTS capture_exceptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  razorpay_payment_id  text NOT NULL,
  razorpay_order_id    text NOT NULL,
  checkout_session_id  uuid REFERENCES checkout_sessions(id) ON DELETE SET NULL,
  -- duplicate_capture: the order the session had already materialised (the capture is NOT its payment)
  order_id             uuid REFERENCES orders(id) ON DELETE SET NULL,
  msme_id              uuid REFERENCES msme_profiles(id) ON DELETE SET NULL,
  amount_paise         bigint NOT NULL CHECK (amount_paise >= 0),
  method               text,
  reason               text NOT NULL CHECK (reason IN ('session_expired', 'duplicate_capture')),
  status               text NOT NULL DEFAULT 'refund_pending'
                         CHECK (status IN ('refund_pending', 'refunding', 'refunded', 'refund_failed')),
  -- the gateway receipt for the refund (<= 40 characters, Razorpay's limit)
  refund_key           text NOT NULL CHECK (length(refund_key) <= 40),
  razorpay_refund_id   text,
  attempts             integer NOT NULL DEFAULT 0,
  last_error           text,
  -- recorded from the simulation path (pay_sim_ ids / payload.simulated): never refunded by a real gateway
  simulated            boolean NOT NULL DEFAULT false,
  webhook_payload      jsonb,
  refunded_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capture_exceptions_payment_uq UNIQUE (razorpay_payment_id),
  CONSTRAINT capture_exceptions_refund_key_uq UNIQUE (refund_key),
  CONSTRAINT capture_exceptions_refund_id_uq UNIQUE (razorpay_refund_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS capture_exceptions_status_idx ON capture_exceptions (status, updated_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS capture_exceptions_order_idx ON capture_exceptions (order_id) WHERE order_id IS NOT NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS set_updated_at ON capture_exceptions;
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON capture_exceptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE capture_exceptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- No policies: no client role reads it. The default privileges grant ALL to the
-- client roles on a new table, so take them back explicitly (ADR 025).
REVOKE ALL ON capture_exceptions FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON capture_exceptions TO service_role;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION capture_payment(
  p_razorpay_order_id   text,
  p_razorpay_payment_id text,
  p_amount_paise        bigint,
  p_method              text,
  p_payload             jsonb,
  p_grace_seconds       integer DEFAULT 900
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order_id uuid;
  v_session  checkout_sessions%ROWTYPE;
  v_exc      capture_exceptions%ROWTYPE;
  v_id       uuid;
  v_reason   text;
BEGIN
  -- (1) Already recorded → the same answer, nothing new (webhook replay, reconcile re-run).
  SELECT order_id INTO v_order_id FROM payments WHERE razorpay_payment_id = p_razorpay_payment_id;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'existing', 'order_id', v_order_id);
  END IF;
  SELECT * INTO v_exc FROM capture_exceptions WHERE razorpay_payment_id = p_razorpay_payment_id;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', v_exc.reason, 'exception_id', v_exc.id, 'order_id', v_exc.order_id, 'created', false);
  END IF;

  -- (2) Lock the session: every capture on one Razorpay order serialises here.
  SELECT * INTO v_session FROM checkout_sessions WHERE razorpay_order_id = p_razorpay_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'unknown_session');
  END IF;

  -- (3) Re-check under the lock: a concurrent call may have recorded THIS payment
  --     while we waited (READ COMMITTED: this statement sees its commit). Without
  --     it, the loser would take the winner's own payment for a duplicate.
  SELECT order_id INTO v_order_id FROM payments WHERE razorpay_payment_id = p_razorpay_payment_id;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'existing', 'order_id', v_order_id);
  END IF;
  SELECT * INTO v_exc FROM capture_exceptions WHERE razorpay_payment_id = p_razorpay_payment_id;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', v_exc.reason, 'exception_id', v_exc.id, 'order_id', v_exc.order_id, 'created', false);
  END IF;

  -- (4) Classify.
  IF v_session.order_id IS NOT NULL OR v_session.status IN ('materializing', 'materialized') THEN
    -- M39: the session was already paid by another payment.
    v_reason := 'duplicate_capture';
  ELSIF v_session.status <> 'created'
     OR (v_session.expires_at IS NOT NULL AND now() > v_session.expires_at + make_interval(secs => GREATEST(p_grace_seconds, 0))) THEN
    -- M21: the frozen price, quote, coupon or pool window lapsed; never honoured.
    v_reason := 'session_expired';
  END IF;

  IF v_reason IS NOT NULL THEN
    v_id := gen_random_uuid();
    INSERT INTO capture_exceptions (
      id, razorpay_payment_id, razorpay_order_id, checkout_session_id, order_id, msme_id,
      amount_paise, method, reason, refund_key, simulated, webhook_payload
    ) VALUES (
      v_id, p_razorpay_payment_id, p_razorpay_order_id, v_session.id, v_session.order_id, v_session.msme_id,
      p_amount_paise, p_method, v_reason, 'rfcap_' || replace(v_id::text, '-', ''),
      p_razorpay_payment_id LIKE 'pay\_sim\_%' OR coalesce(p_payload->>'simulated', '') = 'true', p_payload
    )
    ON CONFLICT (razorpay_payment_id) DO NOTHING;
    IF NOT FOUND THEN
      SELECT * INTO v_exc FROM capture_exceptions WHERE razorpay_payment_id = p_razorpay_payment_id;
      RETURN jsonb_build_object('outcome', v_exc.reason, 'exception_id', v_exc.id, 'order_id', v_exc.order_id, 'created', false);
    END IF;

    IF v_reason = 'session_expired' THEN
      UPDATE checkout_sessions SET status = 'expired', updated_at = now() WHERE id = v_session.id AND status = 'created';
    ELSIF v_session.order_id IS NOT NULL THEN
      -- Ops-visible on the order it duplicated (hidden from the party timelines).
      INSERT INTO order_events (order_id, actor_id, event, payload)
      VALUES (v_session.order_id, NULL, 'duplicate_capture',
              jsonb_build_object('razorpay_payment_id', p_razorpay_payment_id, 'amount_paise', p_amount_paise, 'capture_exception_id', v_id));
    END IF;
    RETURN jsonb_build_object('outcome', v_reason, 'exception_id', v_id, 'order_id', v_session.order_id, 'created', true);
  END IF;

  -- (5) A live session: the ordinary, replay-safe materialisation.
  v_order_id := materialize_order(p_razorpay_order_id, p_razorpay_payment_id, p_amount_paise, p_method, p_payload);
  RETURN jsonb_build_object('outcome', 'materialized', 'order_id', v_order_id);
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION capture_payment(text, text, bigint, text, jsonb, integer) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION capture_payment(text, text, bigint, text, jsonb, integer) TO service_role;
