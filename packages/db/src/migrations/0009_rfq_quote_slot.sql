-- Phase 5 (RFQ) — atomic quote-slot claim so the N-quote cap (default 7) is
-- race-free (done-criterion: the 8th quote is rejected). Returns the new
-- quote_count, or NULL if the RFQ can't accept another quote (cap reached,
-- not active, or expired). Also flips the first quote open → quoted.

CREATE OR REPLACE FUNCTION claim_quote_slot(p_rfq_id uuid)
RETURNS integer
LANGUAGE sql
AS $$
  UPDATE rfqs
     SET quote_count = quote_count + 1,
         status = CASE WHEN status = 'open' THEN 'quoted' ELSE status END,
         updated_at = now()
   WHERE id = p_rfq_id
     AND status IN ('open', 'quoted')
     AND quote_count < max_quotes
     AND expires_at > now()
  RETURNING quote_count;
$$;
--> statement-breakpoint
-- Compensating release if the quote INSERT loses a race (e.g. unique violation),
-- so the count doesn't drift upward.
CREATE OR REPLACE FUNCTION release_quote_slot(p_rfq_id uuid)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE rfqs SET quote_count = GREATEST(quote_count - 1, 0), updated_at = now()
   WHERE id = p_rfq_id;
$$;
