-- Quote extraction + price book (BUILD_PROMPTS S1.1) — additive, idempotent,
-- NOT staged (apply to prod before/with the writer, RULES.md 2).
--
-- quote_extractions: one row per bounded model call on a provider's quote text
-- (the sanitised text, the CLAMPED proposal, cost). The submit route links the
-- provider's confirmation: quotes.extraction_id + extraction_confirmed_at and
-- quote_extractions.decision_id → ai_decisions (feature quote_extraction).
-- provider_price_book: the provider's stated price per (category, unit) from
-- EVERY submitted quote while AGENT_ENABLED — S2.2 Digital Munshi drafts from
-- it; nothing reads it in S1.1. Money in paise, bigint (§2.5 rule 6).
--
-- RLS: provider SELECT own rows; admin/ops SELECT all (the codebase helper is
-- has_role(), there is no is_admin()); NO client writes — service role only.

CREATE TABLE IF NOT EXISTS quote_extractions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id            uuid NOT NULL REFERENCES rfqs(id),
  provider_id       uuid NOT NULL REFERENCES provider_profiles(id),
  user_id           uuid NOT NULL REFERENCES users(id),
  source            text NOT NULL CHECK (source IN ('typed', 'voice')),
  -- the sanitised envelope text: the provider's own words, ≤ 4000 chars
  input_text        text NOT NULL,
  -- the schema object as returned after the server clamp
  proposed          jsonb NOT NULL,
  uncertain_fields  text[] NOT NULL DEFAULT '{}',
  model             text,
  stub              boolean NOT NULL DEFAULT false,
  cost_est_paise    bigint,
  -- set by the submit route when the provider confirms (one ai_decisions row)
  decision_id       uuid REFERENCES ai_decisions(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS quote_extractions_rfq_provider_created_idx
  ON quote_extractions (rfq_id, provider_id, created_at DESC);
--> statement-breakpoint
DROP TRIGGER IF EXISTS quote_extractions_set_updated_at ON quote_extractions;
--> statement-breakpoint
CREATE TRIGGER quote_extractions_set_updated_at
  BEFORE UPDATE ON quote_extractions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE quote_extractions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "quote_extractions: provider read own" ON quote_extractions;
--> statement-breakpoint
CREATE POLICY "quote_extractions: provider read own" ON quote_extractions
  FOR SELECT USING (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));
--> statement-breakpoint
DROP POLICY IF EXISTS "quote_extractions: admin read" ON quote_extractions;
--> statement-breakpoint
CREATE POLICY "quote_extractions: admin read" ON quote_extractions
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON quote_extractions FROM anon, authenticated;
--> statement-breakpoint

-- quotes: the confirmed extraction (at most one quote per extraction).
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS extraction_id uuid REFERENCES quote_extractions(id);
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS extraction_confirmed_at timestamptz;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS quotes_extraction_id_uniq ON quotes (extraction_id) WHERE extraction_id IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS provider_price_book (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id         uuid NOT NULL REFERENCES provider_profiles(id),
  kind                text NOT NULL CHECK (kind IN ('services', 'goods')),
  category_slug       text NOT NULL,
  specialization      text,
  -- services: 'job'; goods: the RFQ's goods_spec.unit
  unit                text NOT NULL,
  price_paise         bigint NOT NULL CHECK (price_paise > 0),
  delivery_days       integer,
  gst_included        boolean,
  transport_included  boolean,
  source_quote_id     uuid NOT NULL UNIQUE REFERENCES quotes(id),
  confirmed_at        timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS provider_price_book_provider_category_confirmed_idx
  ON provider_price_book (provider_id, category_slug, confirmed_at DESC);
--> statement-breakpoint
DROP TRIGGER IF EXISTS provider_price_book_set_updated_at ON provider_price_book;
--> statement-breakpoint
CREATE TRIGGER provider_price_book_set_updated_at
  BEFORE UPDATE ON provider_price_book
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE provider_price_book ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "provider_price_book: provider read own" ON provider_price_book;
--> statement-breakpoint
CREATE POLICY "provider_price_book: provider read own" ON provider_price_book
  FOR SELECT USING (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));
--> statement-breakpoint
DROP POLICY IF EXISTS "provider_price_book: admin read" ON provider_price_book;
--> statement-breakpoint
CREATE POLICY "provider_price_book: admin read" ON provider_price_book
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON provider_price_book FROM anon, authenticated;
