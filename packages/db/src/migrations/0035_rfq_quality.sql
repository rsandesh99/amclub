-- RFQ Quality agent (BUILD_PROMPTS S1.5) — additive, idempotent, NOT staged
-- (apply to prod before the writer deploys, RULES.md 2).
--
-- Two-phase RFQ create behind agents_enabled.rfq_quality: a DEFERRED request is
-- status='open' with fanout_at IS NULL — never a status. Nobody is matched, so
-- no provider can see it; the buyer answers up to three questions or sends it
-- as is; the rfq-expire cron guard releases anything older than
-- agent_settings.rfq_quality_hold_minutes. releaseDeferredRfq
-- (apps/web/lib/rfq/release.ts) is the ONLY writer that sets fanout_at.
--
-- BACKFILL: every RFQ that exists today was fanned out inline at creation, so
-- fanout_at = created_at for all of them. After this migration "deferred"
-- means exactly fanout_at IS NULL. The single-phase create path (flag off)
-- writes fanout_at = now() on insert from the same deploy.
--
-- quality_*: the report the buyer saw (jsonb RfqQualityReport), when it was
-- computed, the buyer's decision (answered | sent_as_is | auto_released |
-- skipped = nothing to ask), when, and the ai_decisions row for a human
-- decision (auto_released and skipped record none — no human).
--
-- RLS: unchanged. The buyer reads own rfqs already; providers read only RFQs
-- they are matched to, and a deferred RFQ has no matches.

ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS fanout_at timestamptz;
--> statement-breakpoint
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS quality_report jsonb;
--> statement-breakpoint
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS quality_checked_at timestamptz;
--> statement-breakpoint
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS quality_decision text;
--> statement-breakpoint
ALTER TABLE rfqs DROP CONSTRAINT IF EXISTS rfqs_quality_decision_check;
--> statement-breakpoint
ALTER TABLE rfqs ADD CONSTRAINT rfqs_quality_decision_check
  CHECK (quality_decision IS NULL OR quality_decision IN ('answered', 'sent_as_is', 'auto_released', 'skipped'));
--> statement-breakpoint
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS quality_decision_at timestamptz;
--> statement-breakpoint
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS quality_decision_id uuid REFERENCES ai_decisions(id);
--> statement-breakpoint

-- Backfill: everything created before this migration was fanned out inline.
UPDATE rfqs SET fanout_at = created_at WHERE fanout_at IS NULL;
--> statement-breakpoint

-- The cron guard's query: open + not yet fanned out, oldest first.
CREATE INDEX IF NOT EXISTS rfqs_deferred_idx
  ON rfqs (created_at) WHERE fanout_at IS NULL AND status = 'open';
