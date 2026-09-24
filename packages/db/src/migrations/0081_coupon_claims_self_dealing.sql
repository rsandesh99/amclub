-- 0081 — Coupon claims and per-buyer limits; the self-dealing pool skip
-- (architecture + security audit, 2026-09-24: M10 parts 2–3, M22). ADR 029.
-- Idempotent: every statement can run twice. No data changes.
--
-- M10: a coupon's usage limit was checked at checkout (used_count < usage_limit)
--      but counted only when the payment materialised the order, so two buyers
--      at the last use both got the discount, and nothing limited one buyer.
--      Now the checkout CLAIMS a use for its session under the coupon's row lock
--      (claim_coupon_for_session): the uses already redeemed plus the live claims
--      of other unpaid sessions must stay under usage_limit, and the same for the
--      buyer under the new per_buyer_limit (NULL = unlimited). A claim lives while
--      its session can still be paid (status created / materializing, not
--      expired); materialize_order then records the redemption as before.
--      record_coupon_redemption is the atomic replacement for the app's
--      read-modify-write fallback in lib/coupons/redeem.ts.
-- M22: a services group member whose committed offer is from their own provider
--      profile is skipped at close with the new reason 'self_dealing'.
--
-- Grants: coupons stay server-read only (0075; ALL revoked from the client roles,
-- which also covers the new column). checkout_sessions.coupon_claimed_at is read
-- with the rest of the owner's row and written only by the function (clients hold
-- no write grant on checkout_sessions, ADR 018). Both functions: service_role only.
--
-- Rollback: DROP FUNCTION claim_coupon_for_session(uuid), record_coupon_redemption(uuid);
-- DROP INDEX checkout_sessions_coupon_hold_idx, coupon_redemptions_coupon_msme_idx;
-- ALTER TABLE coupons DROP COLUMN per_buyer_limit; ALTER TABLE checkout_sessions
-- DROP COLUMN coupon_claimed_at; restore the 0071 skip_reason check. The app
-- reads per_buyer_limit with select('*') and treats a missing value as unlimited.

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS per_buyer_limit integer;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coupons_per_buyer_limit_positive') THEN
    ALTER TABLE coupons ADD CONSTRAINT coupons_per_buyer_limit_positive CHECK (per_buyer_limit IS NULL OR per_buyer_limit > 0);
  END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON coupons FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS coupon_claimed_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS checkout_sessions_coupon_hold_idx
  ON checkout_sessions (coupon_code)
  WHERE coupon_claimed_at IS NOT NULL AND order_id IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS coupon_redemptions_coupon_msme_idx ON coupon_redemptions (coupon_id, msme_id);
--> statement-breakpoint

-- One claim per checkout session, decided under the coupon's row lock. Answers:
--   claimed | already_claimed           — the session holds a use (idempotent)
--   no_coupon | session_closed          — nothing to claim / the session cannot be paid
--   not_found | inactive                — the coupon is gone, switched off or out of dates
--   usage_exceeded                      — redeemed + other live claims reach usage_limit
--   per_buyer_exceeded                  — this buyer's redemptions reach per_buyer_limit
--   per_buyer_pending                   — … counting this buyer's other unpaid sessions
-- Lock order is session → coupon, the same as materialize_order (which locks the
-- session, then bumps coupons.used_count), so the two never deadlock.
CREATE OR REPLACE FUNCTION claim_coupon_for_session(p_session_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_code        text;
  v_msme        uuid;
  v_claimed_at  timestamptz;
  v_status      text;
  v_order       uuid;
  v_expires     timestamptz;
  v_coupon      coupons%ROWTYPE;
  v_held        bigint;
  v_mine_used   bigint;
  v_mine_held   bigint;
BEGIN
  SELECT s.coupon_code, s.msme_id, s.coupon_claimed_at, s.status, s.order_id, s.expires_at
    INTO v_code, v_msme, v_claimed_at, v_status, v_order, v_expires
    FROM checkout_sessions s
   WHERE s.id = p_session_id
     FOR UPDATE;
  IF NOT FOUND OR v_code IS NULL THEN
    RETURN 'no_coupon';
  END IF;
  -- A lapsed session's claim no longer counts for anyone, so it never answers
  -- for a payment either (checked before the replay answer).
  IF v_status <> 'created' OR v_order IS NOT NULL OR (v_expires IS NOT NULL AND v_expires <= now()) THEN
    RETURN 'session_closed';
  END IF;
  IF v_claimed_at IS NOT NULL THEN
    RETURN 'already_claimed';
  END IF;

  -- Every claim on this coupon queues here; each count below then reads the
  -- claims committed before it (READ COMMITTED: a fresh snapshot per statement).
  SELECT * INTO v_coupon FROM coupons WHERE code = v_code FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF NOT v_coupon.is_active OR v_coupon.valid_from > now() OR v_coupon.valid_to < now() THEN
    RETURN 'inactive';
  END IF;

  IF v_coupon.usage_limit IS NOT NULL THEN
    SELECT count(*) INTO v_held
      FROM checkout_sessions s
     WHERE s.coupon_code = v_code
       AND s.coupon_claimed_at IS NOT NULL
       AND s.order_id IS NULL
       AND s.status IN ('created', 'materializing')
       AND (s.expires_at IS NULL OR s.expires_at > now())
       AND s.id <> p_session_id;
    IF v_coupon.used_count + v_held >= v_coupon.usage_limit THEN
      RETURN 'usage_exceeded';
    END IF;
  END IF;

  IF v_coupon.per_buyer_limit IS NOT NULL THEN
    SELECT count(*) INTO v_mine_used
      FROM coupon_redemptions r
     WHERE r.coupon_id = v_coupon.id
       AND r.msme_id = v_msme;
    IF v_mine_used >= v_coupon.per_buyer_limit THEN
      RETURN 'per_buyer_exceeded';
    END IF;
    SELECT count(*) INTO v_mine_held
      FROM checkout_sessions s
     WHERE s.coupon_code = v_code
       AND s.msme_id = v_msme
       AND s.coupon_claimed_at IS NOT NULL
       AND s.order_id IS NULL
       AND s.status IN ('created', 'materializing')
       AND (s.expires_at IS NULL OR s.expires_at > now())
       AND s.id <> p_session_id;
    IF v_mine_used + v_mine_held >= v_coupon.per_buyer_limit THEN
      RETURN 'per_buyer_pending';
    END IF;
  END IF;

  UPDATE checkout_sessions SET coupon_claimed_at = now(), updated_at = now() WHERE id = p_session_id;
  RETURN 'claimed';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_coupon_for_session(uuid) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_coupon_for_session(uuid) TO service_role;
--> statement-breakpoint

-- Record the redemption of a materialised order's coupon: the insert and the
-- used_count bump happen together or not at all (a replay inserts nothing and
-- bumps nothing). Returns true only when this call recorded it.
CREATE OR REPLACE FUNCTION record_coupon_redemption(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_code   text;
  v_msme   uuid;
  v_coupon uuid;
  v_rows   integer;
BEGIN
  SELECT s.coupon_code, s.msme_id INTO v_code, v_msme
    FROM checkout_sessions s
   WHERE s.order_id = p_order_id
   LIMIT 1;
  IF v_code IS NULL THEN
    RETURN false;
  END IF;
  SELECT c.id INTO v_coupon FROM coupons c WHERE c.code = v_code FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO coupon_redemptions (coupon_id, order_id, msme_id)
  VALUES (v_coupon, p_order_id, v_msme)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN false;
  END IF;
  UPDATE coupons SET used_count = used_count + 1, updated_at = now() WHERE id = v_coupon;
  RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION record_coupon_redemption(uuid) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION record_coupon_redemption(uuid) TO service_role;
--> statement-breakpoint

-- M22 — a group member is never quoted by their own provider profile.
DO $$
BEGIN
  IF to_regclass('public.service_pool_members') IS NOT NULL THEN
    ALTER TABLE service_pool_members DROP CONSTRAINT IF EXISTS service_pool_members_skip_reason_check;
    ALTER TABLE service_pool_members ADD CONSTRAINT service_pool_members_skip_reason_check
      CHECK (skip_reason IN ('provider_inactive', 'rfq_closed', 'already_quoted', 'declined', 'self_dealing'));
  END IF;
END $$;
