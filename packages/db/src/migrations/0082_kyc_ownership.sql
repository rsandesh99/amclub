-- 0082 — KYC ownership (architecture + security audit 2026-09-24, finding M12; ADR 028).
-- Additive and idempotent, NOT staged.
--
-- A vendor answer proved that a Udyam number or a bank account EXISTS, not that the
-- caller owns it. From ADR 028 every attempt row carries an ownership OUTCOME and the
-- chip / penny-drop flag follows only from 'verified' (an ID or GST-locked-name match,
-- shared kycOwnership). Everything else is kept for ops review.
--
-- 1. udyam_verifications.outcome ('verified' | 'name_mismatch' | 'not_verified' | 'stub'
--    | 'udyam_already_claimed') and released_at. A CLAIM is a row with outcome 'verified'
--    and released_at IS NULL; a repeat verification by the holder is recorded born-released.
-- 2. Backfill: stub → 'stub', vendor-verified → 'verified' (legacy rows had no ownership
--    check; production ran the stub, so none exist there), else 'not_verified'.
-- 3. Duplicate guard BEFORE the unique index: one user's older verified rows for the same
--    number are released (the newest stays the claim); across users the account that
--    verified FIRST keeps the claim, and every later account's row becomes
--    'udyam_already_claimed' (released) and loses its udyam_verified chip unless it holds
--    another claim. The notice reports how many rows moved.
-- 4. One active verified claim per Udyam number: unique partial index on upper(number).
-- 5. bank_account_verifications.outcome ('verified' | 'name_mismatch' | 'not_verified' |
--    'stub'); NULL on admin_override rows (an audited admin decision, not a vendor attempt).
-- 6. Review indexes for the admin verification queue.
-- Grants (ADR 025): no client write anywhere. udyam_verifications is SELECT for
-- authenticated only (RLS: own rows + admin / ops; the owner may read their outcome) and
-- nothing for anon; bank_account_verifications stays service-role only.

-- ─── 1. udyam_verifications: outcome + released_at ───────────────────────────
ALTER TABLE udyam_verifications ADD COLUMN IF NOT EXISTS outcome text;
--> statement-breakpoint
ALTER TABLE udyam_verifications ADD COLUMN IF NOT EXISTS released_at timestamptz;
--> statement-breakpoint
ALTER TABLE udyam_verifications DROP CONSTRAINT IF EXISTS udyam_verifications_outcome_check;
--> statement-breakpoint
ALTER TABLE udyam_verifications ADD CONSTRAINT udyam_verifications_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('verified', 'name_mismatch', 'not_verified', 'stub', 'udyam_already_claimed'));
--> statement-breakpoint

-- ─── 2. backfill ─────────────────────────────────────────────────────────────
UPDATE udyam_verifications
SET outcome = CASE WHEN stub THEN 'stub' WHEN verified THEN 'verified' ELSE 'not_verified' END
WHERE outcome IS NULL;
--> statement-breakpoint

-- ─── 3. duplicate guard (before the unique index) ────────────────────────────
DO $m12$
DECLARE
  n_self int := 0;
  n_other int := 0;
  demoted uuid[];
BEGIN
  -- 3a. One user, several verified rows for one number: the newest stays the claim.
  UPDATE udyam_verifications v
  SET released_at = now()
  WHERE v.outcome = 'verified'
    AND v.released_at IS NULL
    AND EXISTS (
      SELECT 1 FROM udyam_verifications w
      WHERE w.user_id = v.user_id
        AND upper(w.udyam_number) = upper(v.udyam_number)
        AND w.outcome = 'verified'
        AND w.released_at IS NULL
        AND (w.created_at, w.id) > (v.created_at, v.id)
    );
  GET DIAGNOSTICS n_self = ROW_COUNT;

  -- 3b. Several users: the account that verified first keeps it.
  WITH firsts AS (
    SELECT user_id, upper(udyam_number) AS u, min(created_at) AS first_at
    FROM udyam_verifications
    WHERE outcome = 'verified'
    GROUP BY user_id, upper(udyam_number)
  ), ranked AS (
    SELECT v.id, v.user_id,
           row_number() OVER (PARTITION BY upper(v.udyam_number) ORDER BY f.first_at, v.user_id) AS rn
    FROM udyam_verifications v
    JOIN firsts f ON f.user_id = v.user_id AND f.u = upper(v.udyam_number)
    WHERE v.outcome = 'verified' AND v.released_at IS NULL
  ), moved AS (
    UPDATE udyam_verifications v
    SET outcome = 'udyam_already_claimed', released_at = now()
    FROM ranked r
    WHERE r.id = v.id AND r.rn > 1
    RETURNING v.user_id
  )
  SELECT count(*)::int, array_agg(DISTINCT user_id) INTO n_other, demoted FROM moved;

  -- A demoted account keeps no chip it cannot back with another claim.
  IF n_other > 0 THEN
    UPDATE msme_profiles m
    SET udyam_verified = false, updated_at = now()
    WHERE m.user_id = ANY (demoted)
      AND m.udyam_verified
      AND NOT EXISTS (
        SELECT 1 FROM udyam_verifications c
        WHERE c.user_id = m.user_id AND c.outcome = 'verified' AND c.released_at IS NULL
      );
    UPDATE provider_profiles p
    SET udyam_verified = false, updated_at = now()
    WHERE p.user_id = ANY (demoted)
      AND p.udyam_verified
      AND NOT EXISTS (
        SELECT 1 FROM udyam_verifications c
        WHERE c.user_id = p.user_id AND c.outcome = 'verified' AND c.released_at IS NULL
      );
  END IF;

  RAISE NOTICE '0082: % repeat verification row(s) released; % duplicate claim row(s) moved to udyam_already_claimed', n_self, n_other;
END
$m12$;
--> statement-breakpoint

-- ─── 4. one active verified claim per Udyam number ───────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS udyam_verifications_one_claim_uidx
  ON udyam_verifications (upper(udyam_number))
  WHERE outcome = 'verified' AND released_at IS NULL;
--> statement-breakpoint

-- ─── 5. bank_account_verifications.outcome ───────────────────────────────────
ALTER TABLE bank_account_verifications ADD COLUMN IF NOT EXISTS outcome text;
--> statement-breakpoint
ALTER TABLE bank_account_verifications DROP CONSTRAINT IF EXISTS bank_account_verifications_outcome_check;
--> statement-breakpoint
ALTER TABLE bank_account_verifications ADD CONSTRAINT bank_account_verifications_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('verified', 'name_mismatch', 'not_verified', 'stub'));
--> statement-breakpoint
UPDATE bank_account_verifications
SET outcome = CASE WHEN stub THEN 'stub' WHEN verified THEN 'verified' ELSE 'not_verified' END
WHERE outcome IS NULL AND provider IN ('surepass', 'stub');
--> statement-breakpoint

-- ─── 6. review indexes (the admin verification queue) ────────────────────────
CREATE INDEX IF NOT EXISTS udyam_verifications_review_idx
  ON udyam_verifications (created_at DESC)
  WHERE outcome IN ('name_mismatch', 'udyam_already_claimed');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bank_account_verifications_review_idx
  ON bank_account_verifications (created_at DESC)
  WHERE outcome = 'name_mismatch';
--> statement-breakpoint

-- ─── grants (ADR 025): an explicit decision for both tables ──────────────────
-- udyam_verifications: signed-in users SELECT (RLS: own rows; admin / ops all), nothing
-- else — the default-privilege TRUNCATE / REFERENCES / TRIGGER and anon's SELECT go too.
REVOKE ALL ON udyam_verifications FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON udyam_verifications TO authenticated;
--> statement-breakpoint
-- bank_account_verifications: service role only (as 0016 / policies.sql).
REVOKE ALL ON bank_account_verifications FROM anon, authenticated;
