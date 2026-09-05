-- Phase S2.2 — persist GSTIN verification attempts (audit 4c; bank-pattern
-- clone from 0016's bank_account_verifications, adjusted per founder spec).
--
-- Every /kyc/verify-gstin attempt (success or failure) is recorded so the
-- goods activation gate can consume a server-set fact. No fingerprint: the
-- GSTIN is itself the public registry key (unlike an account number).
-- `result` stores GST-registry business facts only:
--   { legalName, tradeName, state, registrationDate, isActive, error }.
-- provider values: 'surepass' | 'stub' | 'admin_attest' (audited founder
-- attestation for providers verified before this table existed).
--
-- RLS (founder spec — deliberate delta from bank's zero-policy posture):
-- self read + admin read; NO client write policies; writes revoked.

CREATE TABLE IF NOT EXISTS gstin_verifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  gstin      text NOT NULL,
  verified   boolean NOT NULL,
  -- true when the dev stub answered (no KYC_API_KEY) — never counts as verified
  stub       boolean NOT NULL DEFAULT false,
  -- 'surepass' | 'stub' | 'admin_attest'
  provider   text NOT NULL,
  result     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS gstin_verifications_lookup_idx
  ON gstin_verifications (user_id, gstin, created_at DESC);
--> statement-breakpoint
ALTER TABLE gstin_verifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "gstin_verifications: self read" ON gstin_verifications;
--> statement-breakpoint
CREATE POLICY "gstin_verifications: self read" ON gstin_verifications
  FOR SELECT USING (user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "gstin_verifications: admin read" ON gstin_verifications;
--> statement-breakpoint
CREATE POLICY "gstin_verifications: admin read" ON gstin_verifications
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON gstin_verifications FROM anon, authenticated;
