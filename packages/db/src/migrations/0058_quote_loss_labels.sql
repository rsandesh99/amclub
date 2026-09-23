-- Experience v3 E7 (docs/prd/PRD_EXPERIENCE_V3.md FR-7.3, N22) — quote loss labels.
--
-- When a quote is accepted, finalizeQuoteAcceptance writes ONE quote_events row
-- 'lost' per other open quote on the RFQ: payload {v, accepted_quote_id,
-- price_delta_paise, days_delta} against the winner (shared quote-loss.ts).
--
--   1. 'lost' joins the event_type CHECK (full list restated, as 0029 / 0034 did).
--   2. quote_events_lost_once: at most one 'lost' row per quote — a replayed or
--      repaired finalize can never write a second.
--   3. The provider read policy excludes 'lost' rows: the delta plus the
--      provider's own price would rebuild the winner's exact price. Providers
--      see only n-gated aggregates (insights, server-side). The buyer and
--      admin/ops policies are unchanged (the buyer saw every quote anyway).
--      rls/policies.sql carries the same narrowed policy.
--
-- No money path reads or writes these rows. Writes stay service role only.
--
-- Rollback: DROP INDEX quote_events_lost_once; DELETE FROM quote_events WHERE
-- event_type = 'lost' (service role; append-only blocks UPDATE, not DELETE);
-- restore the 0034 CHECK and the 0016 provider policy.

ALTER TABLE quote_events DROP CONSTRAINT IF EXISTS quote_events_event_type_check;
--> statement-breakpoint
ALTER TABLE quote_events ADD CONSTRAINT quote_events_event_type_check CHECK (
  event_type IN ('submitted', 'declined', 'withdrawn', 'accepted', 'expired', 'auto_declined', 'match_declined', 'revised', 'lost')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS quote_events_lost_once ON quote_events (quote_id) WHERE event_type = 'lost';
--> statement-breakpoint
DROP POLICY IF EXISTS "quote_events: provider read own" ON quote_events;
--> statement-breakpoint
CREATE POLICY "quote_events: provider read own" ON quote_events
  FOR SELECT USING (
    event_type <> 'lost'
    AND quote_id IN (
      SELECT id FROM quotes
      WHERE provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
    )
  );
