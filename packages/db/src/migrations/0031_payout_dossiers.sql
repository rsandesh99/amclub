-- Payout dossiers (BUILD_PROMPTS S1.4) — additive, idempotent, NOT staged
-- (apply to prod before/with the writer, RULES.md 2). Numbered 0031 because
-- 0030 is the S0.5 WhatsApp rails in this tree (the S1.4 prompt said 0030;
-- codebase wins — docs/FOLLOWUPS.md "Agent S1.4").
--
-- payout_dossiers: one row per Payout-Evidence agent run on a HELD payout —
-- deterministic checks, vision findings, anomalies, the RULE recommendation,
-- then the founder's decision. A decision is written ONCE (trigger). Approve
-- is never written here alone: it is the founder's tap on the existing release
-- route (POST /api/v1/admin/payouts/[id]), which also closes the dossier.
-- Hold writes nothing money-related — the payout simply stays held.
--
-- evidence_photo_hashes: dHash per evidence photo (agent-owned telemetry) so
-- the agent can spot a photo re-used across a provider's orders.
--
-- RLS: admin/ops read on both; NO client writes (runtime service role + the two
-- admin routes write).

CREATE TABLE IF NOT EXISTS payout_dossiers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES orders(id),
  payout_id         uuid REFERENCES payouts(id),
  run_id            uuid REFERENCES agent_runs(id),
  kind              text NOT NULL CHECK (kind IN ('service', 'goods')),
  checks            jsonb NOT NULL,
  anomalies         text[] NOT NULL DEFAULT '{}',
  photo_findings    jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommendation    text NOT NULL CHECK (recommendation IN ('approve', 'hold')),
  rationale         text[] NOT NULL DEFAULT '{}',
  model_cost_paise  bigint NOT NULL DEFAULT 0,
  decision          text CHECK (decision IS NULL OR decision IN ('approve', 'hold')),
  decision_note     text,
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,
  decision_id       uuid REFERENCES ai_decisions(id),
  -- founder notification sent once per dossier (idempotent notify route)
  notified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS payout_dossiers_order_run_uniq ON payout_dossiers (order_id, run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payout_dossiers_order_idx ON payout_dossiers (order_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payout_dossiers_created_idx ON payout_dossiers (created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payout_dossiers_pending_idx ON payout_dossiers (created_at DESC) WHERE decision IS NULL;
--> statement-breakpoint
-- A decision is written once: once decision is set, none of the decision
-- columns may change. updated_at is maintained here too (one BEFORE UPDATE
-- trigger per table keeps the manifest honest).
CREATE OR REPLACE FUNCTION payout_dossiers_decision_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.decision IS NOT NULL AND (
       NEW.decision      IS DISTINCT FROM OLD.decision
    OR NEW.decided_by    IS DISTINCT FROM OLD.decided_by
    OR NEW.decided_at    IS DISTINCT FROM OLD.decided_at
    OR NEW.decision_id   IS DISTINCT FROM OLD.decision_id
    OR NEW.decision_note IS DISTINCT FROM OLD.decision_note
  ) THEN
    RAISE EXCEPTION 'payout_dossiers.decision is written once (dossier %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payout_dossiers_decision_guard ON payout_dossiers;
--> statement-breakpoint
CREATE TRIGGER payout_dossiers_decision_guard
  BEFORE UPDATE ON payout_dossiers
  FOR EACH ROW EXECUTE FUNCTION payout_dossiers_decision_once();
--> statement-breakpoint
ALTER TABLE payout_dossiers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "payout_dossiers: admin read" ON payout_dossiers;
--> statement-breakpoint
CREATE POLICY "payout_dossiers: admin read" ON payout_dossiers
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON payout_dossiers FROM anon, authenticated;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS evidence_photo_hashes (
  doc_id       uuid PRIMARY KEY REFERENCES order_documents(id) ON DELETE CASCADE,
  order_id     uuid NOT NULL REFERENCES orders(id),
  provider_id  uuid NOT NULL REFERENCES provider_profiles(id),
  -- 64-bit dHash as 16 lowercase hex chars
  dhash        text NOT NULL CHECK (dhash ~ '^[0-9a-f]{16}$'),
  created_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS evidence_photo_hashes_provider_dhash_idx ON evidence_photo_hashes (provider_id, dhash);
--> statement-breakpoint
ALTER TABLE evidence_photo_hashes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "evidence_photo_hashes: admin read" ON evidence_photo_hashes;
--> statement-breakpoint
CREATE POLICY "evidence_photo_hashes: admin read" ON evidence_photo_hashes
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON evidence_photo_hashes FROM anon, authenticated;
