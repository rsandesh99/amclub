-- Experience v3 E12b (N21) — speed tiers on a services quote (ADR 020). Money;
-- dark behind agent_settings.quote_options_enabled (default off).
--
--   quote_options        at most one Economy and one Express row per quote
--                        REVISION (the quote row itself is Standard). Rows are
--                        immutable: a revision writes a new set under the new
--                        revision number, so a checkout session frozen on an
--                        older option still resolves. Service role only — the
--                        API is the only reader and writer (clients never read
--                        quotes' money columns directly either).
--   quotes.selected_option_id
--                        the option the buyer paid for (NULL = Standard);
--                        written by finalizeQuoteAcceptance from the session.
--   checkout_sessions.quote_option_id
--                        the option a session is frozen on (NULL = Standard).
--
-- Backfill: none (NULL = Standard = every quote before this migration).
-- Rollback: DROP TABLE quote_options; ALTER TABLE quotes DROP COLUMN
--   selected_option_id; ALTER TABLE checkout_sessions DROP COLUMN
--   quote_option_id; (after turning quote_options_enabled off).

CREATE TABLE IF NOT EXISTS quote_options (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id       uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  revision       integer NOT NULL CHECK (revision >= 1),
  label          text NOT NULL CHECK (label IN ('economy', 'express')),
  price_paise    bigint NOT NULL CHECK (price_paise > 0),
  delivery_days  integer NOT NULL CHECK (delivery_days BETWEEN 1 AND 365),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_id, revision, label)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS quote_options_quote_idx ON quote_options (quote_id, revision);
--> statement-breakpoint
ALTER TABLE quote_options ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON quote_options FROM anon, authenticated;
--> statement-breakpoint

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS selected_option_id uuid REFERENCES quote_options(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS quote_option_id uuid REFERENCES quote_options(id) ON DELETE SET NULL;
