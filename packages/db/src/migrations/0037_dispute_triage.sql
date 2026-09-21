-- Dispute-Triage agent (BUILD_PROMPTS S1.7) — additive, idempotent, NOT staged
-- (apply to prod before the writer deploys, RULES.md 2).
--
-- dispute_statements (SPINE, not agent): ONE statement per party on an open
-- dispute (unique (dispute_id, role)), contact-masked (`redacted`), up to five
-- of the order's own documents attached, editable through PATCH while the
-- dispute is open and no triage exists yet. Written by the parties through one
-- route (service role after the party check); readable by both parties and
-- admin/ops.
--
-- dispute_triages (agent-owned; mirrors payout_dossiers): one row per triage
-- run — deterministic checks, the validated strict card (no amount, no
-- resolution, no tool fields), model cost, then the founder's decision written
-- ONCE (trigger) by the EXISTING resolve route when it is passed a triage_id.
-- The card never moves money; resolveDispute stays the only money path.
--
-- disputes.triage_id: the latest triage (re-triage moves it; history stays).
--
-- RLS: dispute_statements — the order's parties + admin/ops read, no client
-- writes; dispute_triages — admin/ops read only, no client writes.

CREATE TABLE IF NOT EXISTS dispute_statements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id      uuid NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  order_id        uuid NOT NULL REFERENCES orders(id),
  author_user_id  uuid NOT NULL REFERENCES users(id),
  role            text NOT NULL CHECK (role IN ('buyer', 'provider')),
  body            text NOT NULL CHECK (char_length(body) <= 2000),
  redacted        boolean NOT NULL DEFAULT false,
  document_ids    uuid[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
--> statement-breakpoint
-- One statement per party.
CREATE UNIQUE INDEX IF NOT EXISTS dispute_statements_party_uniq ON dispute_statements (dispute_id, role);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dispute_statements_dispute_idx ON dispute_statements (dispute_id);
--> statement-breakpoint
DROP TRIGGER IF EXISTS dispute_statements_set_updated_at ON dispute_statements;
--> statement-breakpoint
CREATE TRIGGER dispute_statements_set_updated_at
  BEFORE UPDATE ON dispute_statements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE dispute_statements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "dispute_statements: parties read" ON dispute_statements;
--> statement-breakpoint
-- The same party predicate the "disputes: parties all" policy uses.
CREATE POLICY "dispute_statements: parties read" ON dispute_statements
  FOR SELECT USING (
    deleted_at IS NULL
    AND order_id IN (
      SELECT id FROM orders
      WHERE msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
         OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "dispute_statements: admin read" ON dispute_statements;
--> statement-breakpoint
CREATE POLICY "dispute_statements: admin read" ON dispute_statements
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON dispute_statements FROM anon, authenticated;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS dispute_triages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id        uuid NOT NULL REFERENCES disputes(id),
  order_id          uuid NOT NULL REFERENCES orders(id),
  run_id            uuid REFERENCES agent_runs(id),
  kind              text NOT NULL CHECK (kind IN ('service', 'goods')),
  -- TriageCheck[]
  checks            jsonb NOT NULL,
  -- the validated disputeTriageSchema (strict; no amount / resolution / tool fields)
  triage            jsonb NOT NULL,
  model_cost_paise  bigint NOT NULL DEFAULT 0,
  stub              boolean NOT NULL DEFAULT false,
  -- the founder's click on the resolve route, written once
  decision          text CHECK (decision IS NULL OR decision IN ('refund_full', 'refund_partial', 'release')),
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,
  decision_id       uuid REFERENCES ai_decisions(id),
  -- ops notification sent once per triage (idempotent notify route)
  notified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS dispute_triages_dispute_run_uniq ON dispute_triages (dispute_id, run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dispute_triages_dispute_created_idx ON dispute_triages (dispute_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dispute_triages_pending_idx ON dispute_triages (created_at DESC) WHERE decision IS NULL;
--> statement-breakpoint
-- A decision is written once (the 0031 payout_dossiers pattern, new function name).
CREATE OR REPLACE FUNCTION dispute_triages_decision_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.decision IS NOT NULL AND (
       NEW.decision    IS DISTINCT FROM OLD.decision
    OR NEW.decided_by  IS DISTINCT FROM OLD.decided_by
    OR NEW.decided_at  IS DISTINCT FROM OLD.decided_at
    OR NEW.decision_id IS DISTINCT FROM OLD.decision_id
  ) THEN
    RAISE EXCEPTION 'dispute_triages.decision is written once (triage %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dispute_triages_decision_guard ON dispute_triages;
--> statement-breakpoint
CREATE TRIGGER dispute_triages_decision_guard
  BEFORE UPDATE ON dispute_triages
  FOR EACH ROW EXECUTE FUNCTION dispute_triages_decision_once();
--> statement-breakpoint
ALTER TABLE dispute_triages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "dispute_triages: admin read" ON dispute_triages;
--> statement-breakpoint
CREATE POLICY "dispute_triages: admin read" ON dispute_triages
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON dispute_triages FROM anon, authenticated;
--> statement-breakpoint

-- The latest triage on the dispute (set by the runtime after the write; re-triage moves it).
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS triage_id uuid REFERENCES dispute_triages(id);
