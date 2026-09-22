-- Digital Munshi v1 (BUILD_PROMPTS S2.2) — additive, idempotent, NOT staged
-- (apply to prod before the writer deploys, RULES.md 2).
--
-- munshi_drafts (agent-owned): one row per Munshi proposal — a quote draft, a
-- clarifying question, a skip with a reason, or a reply on a quote thread.
-- `draft` is the validated MunshiDraft / ThreadReplyDraft; `basis` the
-- price-book rows the band was computed from (refs + paise, never buyer
-- text); `status` moves proposed → approved | edited | skipped | expired |
-- failed. The provider's tap (WhatsApp button, web, mobile, or an allow-listed
-- voice "yes") writes ai_decisions (feature munshi_draft | munshi_reply) and
-- the ORDINARY quote / clarification / message route runs under the
-- provider's delegated token; result_ref links the row it created. Nothing in
-- this migration is a money or status path.
--
-- munshi_provider_state (agent-owned): per-provider scan cursor, the daily
-- draft counter (IST date), pause, and the window-warning reminders keyed by
-- rfq id.
--
-- provider_price_book gains accepted_at (set by finalizeQuoteAcceptance for
-- the winning quote; backfilled below), deleted_at (the provider's soft
-- delete through the route) and source ('quote' from a submit, 'manual' from
-- POST /partner/price-book — how a provider with no history seeds Munshi).
--
-- quotes.munshi_draft_id links a submitted quote to the draft it came from
-- (the S1.2 column grant list is restated with it).
--
-- ai_decisions_feature_check restated with 'munshi_reply'.
-- RLS: provider reads own; admin / ops read all; no client writes.

CREATE TABLE IF NOT EXISTS munshi_drafts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id       uuid NOT NULL REFERENCES provider_profiles(id),
  user_id           uuid NOT NULL REFERENCES users(id),
  rfq_id            uuid REFERENCES rfqs(id),
  quote_id          uuid REFERENCES quotes(id),
  kind              text NOT NULL CHECK (kind IN ('quote', 'ask', 'skip', 'reply')),
  run_id            uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  -- MunshiDraft (quote | ask | skip) or ThreadReplyDraft (reply), schema-validated and clamped
  draft             jsonb NOT NULL,
  -- MunshiBasisRow[] — { price_book_id, price_paise, confirmed_at, accepted }
  basis             jsonb NOT NULL DEFAULT '[]'::jsonb,
  status            text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'edited', 'skipped', 'expired', 'failed')),
  decision_id       uuid REFERENCES ai_decisions(id),
  -- { quote_id } | { clarification_id } | { message_id } | { error } | { redraft: true }
  result_ref        jsonb,
  -- { whatsapp: <wa_messages.id>, web: true, notification: true }
  delivered         jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_cost_paise  bigint NOT NULL DEFAULT 0,
  stub              boolean NOT NULL DEFAULT false,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
--> statement-breakpoint
-- One OPEN draft per (rfq, provider); reply drafts are keyed by quote instead.
CREATE UNIQUE INDEX IF NOT EXISTS munshi_drafts_open_rfq_provider_uidx
  ON munshi_drafts (rfq_id, provider_id)
  WHERE kind <> 'reply' AND status = 'proposed' AND deleted_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS munshi_drafts_open_reply_quote_uidx
  ON munshi_drafts (quote_id)
  WHERE kind = 'reply' AND status = 'proposed' AND deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS munshi_drafts_provider_status_created_idx
  ON munshi_drafts (provider_id, status, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS munshi_drafts_run_idx ON munshi_drafts (run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS munshi_drafts_rfq_idx ON munshi_drafts (rfq_id);
--> statement-breakpoint
DROP TRIGGER IF EXISTS munshi_drafts_set_updated_at ON munshi_drafts;
--> statement-breakpoint
CREATE TRIGGER munshi_drafts_set_updated_at
  BEFORE UPDATE ON munshi_drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS munshi_provider_state (
  provider_id        uuid PRIMARY KEY REFERENCES provider_profiles(id),
  user_id            uuid NOT NULL REFERENCES users(id),
  last_scan_at       timestamptz,
  last_scan_run_id   uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  drafts_today       integer NOT NULL DEFAULT 0,
  drafts_today_date  date,
  paused_until       timestamptz,
  -- the provider's WhatsApp / draft language (set at enable; en | hi | te | ta)
  locale             text NOT NULL DEFAULT 'en',
  -- { "<rfq_id>": { warned_at } } — the once-per-match window warning
  munshi_reminders   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS munshi_provider_state_set_updated_at ON munshi_provider_state;
--> statement-breakpoint
CREATE TRIGGER munshi_provider_state_set_updated_at
  BEFORE UPDATE ON munshi_provider_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ── provider_price_book: accepted marker, soft delete, source ──────────────
ALTER TABLE provider_price_book ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
--> statement-breakpoint
ALTER TABLE provider_price_book ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
--> statement-breakpoint
ALTER TABLE provider_price_book ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'quote';
--> statement-breakpoint
ALTER TABLE provider_price_book DROP CONSTRAINT IF EXISTS provider_price_book_source_check;
--> statement-breakpoint
ALTER TABLE provider_price_book ADD CONSTRAINT provider_price_book_source_check CHECK (source IN ('quote', 'manual'));
--> statement-breakpoint
-- A manual row has no source quote: relax NOT NULL (the UNIQUE stays; NULLs are distinct).
ALTER TABLE provider_price_book ALTER COLUMN source_quote_id DROP NOT NULL;
--> statement-breakpoint
-- Backfill accepted_at from the quotes that were accepted before this migration (idempotent: only NULLs).
UPDATE provider_price_book pb
   SET accepted_at = COALESCE(q.updated_at, now())
  FROM quotes q
 WHERE q.id = pb.source_quote_id
   AND q.status = 'accepted'
   AND pb.accepted_at IS NULL;
--> statement-breakpoint

-- ── quotes.munshi_draft_id + the S1.2 column grant list restated ───────────
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS munshi_draft_id uuid REFERENCES munshi_drafts(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS quotes_munshi_draft_idx ON quotes (munshi_draft_id) WHERE munshi_draft_id IS NOT NULL;
--> statement-breakpoint
REVOKE SELECT ON quotes FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT (
  id, rfq_id, provider_id, price_paise, delivery_days, scope, message,
  gst_included, transport_included, valid_until, advance_percent,
  status, created_at, updated_at,
  extraction_id, extraction_confirmed_at,
  decline_reason, decline_message, decline_message_locale, declined_by, declined_at, decline_decision_id,
  revision, revised_at,
  munshi_draft_id
) ON quotes TO anon, authenticated;
--> statement-breakpoint

-- ── ai_decisions feature CHECK restated with munshi_reply ───────────────────
ALTER TABLE ai_decisions DROP CONSTRAINT IF EXISTS ai_decisions_feature_check;
--> statement-breakpoint
ALTER TABLE ai_decisions ADD CONSTRAINT ai_decisions_feature_check CHECK (feature IN (
  'catalog_draft', 'payout_dossier', 'extraction_correction',
  'pool_draft', 'pool_card', 'documents_draft',
  'agent_tool', 'quote_extraction', 'decline_message', 'onboarding',
  'dispute_triage', 'rfq_quality', 'munshi_draft', 'support_reply', 'score_note',
  'rfq_intake', 'munshi_reply'
));
--> statement-breakpoint

-- ── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE munshi_drafts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "munshi_drafts: provider read own" ON munshi_drafts;
--> statement-breakpoint
CREATE POLICY "munshi_drafts: provider read own" ON munshi_drafts
  FOR SELECT USING (deleted_at IS NULL AND provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));
--> statement-breakpoint
DROP POLICY IF EXISTS "munshi_drafts: admin read" ON munshi_drafts;
--> statement-breakpoint
CREATE POLICY "munshi_drafts: admin read" ON munshi_drafts
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON munshi_drafts FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE munshi_provider_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "munshi_provider_state: provider read own" ON munshi_provider_state;
--> statement-breakpoint
CREATE POLICY "munshi_provider_state: provider read own" ON munshi_provider_state
  FOR SELECT USING (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));
--> statement-breakpoint
DROP POLICY IF EXISTS "munshi_provider_state: admin read" ON munshi_provider_state;
--> statement-breakpoint
CREATE POLICY "munshi_provider_state: admin read" ON munshi_provider_state
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON munshi_provider_state FROM anon, authenticated;
