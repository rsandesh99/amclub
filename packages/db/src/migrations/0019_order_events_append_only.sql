-- Phase S1.1 — order_events append-only enforcement (RULES.md rule 3).
-- Additive only. Brings order_events in line with the protections quote_events
-- (0016) and terms_acceptances (0017) already carry: a BEFORE UPDATE trigger
-- raises, UPDATE/DELETE are revoked from client roles. INSERT is untouched
-- (the addEvent path and the parties-insert RLS policy are unchanged).
--
-- Reuses raise_append_only() from 0017 — do not create a duplicate.
-- The REVOKE list matches 0016 verbatim (anon, authenticated): the service
-- role keeps DELETE, which the kill-test cleanup scripts depend on — the
-- exact posture quote_events lives with today.

DROP TRIGGER IF EXISTS order_events_no_update ON order_events;
--> statement-breakpoint
CREATE TRIGGER order_events_no_update
  BEFORE UPDATE ON order_events
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON order_events FROM anon, authenticated;
