-- Security follow-up: party write guards (docs/USER_EXPECTATIONS_AUDIT.md P0-2,
-- P0-3, P0-10, P0-12). NOT staged. It only narrows client privileges and adds
-- nothing structural beyond one trigger. Numbered 0043 because 0041 is used
-- twice (0041_support + 0041_users_privilege_guard) and 0042_amc_score is
-- claimed by the S2.4 branch.
--
-- Every app write to these tables already goes through the service role, which
-- keeps its grants and bypasses RLS:
--   messages / conversations: POST /api/v1/quotes/[quoteId]/messages
--     (createAdminClient; redactContactInfo runs before the insert)
--   order_events: lib/orders/transitions.ts, lib/mart/goods-transitions.ts,
--     payout.ts, disputes/resolve.ts, the order + admin routes (all
--     createAdminClient) and materialize_order() (SECURITY DEFINER, 0003)
--   audit_logs: lib/audit/log.ts and the admin routes (createAdminClient)
--
-- P0-2 messages were mutable. "messages: parties all" was FOR ALL, so either
-- party could UPDATE or DELETE the other side's messages (including putting back
-- a redacted phone number) and INSERT unredacted text that bypassed the §9.3
-- mask. "conversations: parties all" was also FOR ALL, and messages cascade on
-- conversation delete, so a party could wipe the whole thread. Parties now get
-- SELECT only on both tables, and INSERT/UPDATE/DELETE are revoked from client
-- roles. No client INSERT policy is kept: the one writer is the route, and a
-- direct insert would skip the contact mask.
--
-- P0-3 order_events were forgeable. "order_events: parties insert" let either
-- party insert any event with any actor_id, for example a fake payout_paid or
-- manual_refund in their own timeline. No client path writes events, so the
-- policy is dropped and INSERT is revoked. "admin all" becomes "admin read":
-- admin writes already go through the service role. UPDATE/DELETE were revoked
-- in 0019.
--
-- P0-10 audit_logs was mutable. It now gets the same append-only posture as
-- order_events (0019): a BEFORE UPDATE raise_append_only() trigger (from 0017),
-- which raises for every role, plus INSERT/UPDATE/DELETE revoked from client
-- roles. The service role keeps DELETE, which the kill-test cleanup scripts
-- depend on; this matches order_events and quote_events.
--
-- P0-12 agent detector internals were owner-readable. injection_suspected events
-- carry the detector's score and hits, a tuning oracle for injection attempts,
-- and "agent_events: self read" returned them to the run's owner. The self-read
-- policy now excludes that kind, and admins still read everything. The fix is
-- in RLS rather than in the payload because agent_events is append-only (0026):
-- a slimmer payload could not scrub rows already written.
--
-- Rollback (reopens the defects; prefer a forward fix):
--   DROP POLICY "messages: parties read" ON messages;
--   CREATE POLICY "messages: parties all" ON messages FOR ALL USING (<parties>);
--   GRANT INSERT, UPDATE, DELETE ON messages TO authenticated;
--   DROP POLICY "conversations: parties read" ON conversations;
--   CREATE POLICY "conversations: parties all" ON conversations FOR ALL USING (<parties>);
--   GRANT INSERT, UPDATE, DELETE ON conversations TO authenticated;
--   DROP POLICY "order_events: admin read" ON order_events;
--   CREATE POLICY "order_events: parties insert" ... / "order_events: admin all" ...
--     (as in rls/policies.sql before this change);
--   GRANT INSERT ON order_events TO authenticated;
--   DROP TRIGGER audit_logs_no_update ON audit_logs;
--   GRANT INSERT, UPDATE, DELETE ON audit_logs TO authenticated;
--   recreate "agent_events: self read" without the kind filter (0026).
-- Every rolled-back GRANT restores the Supabase default for that role.

-- ─── P0-2 conversations + messages: parties read, service-role write ─────────
DROP POLICY IF EXISTS "conversations: parties all" ON conversations;
--> statement-breakpoint
DROP POLICY IF EXISTS "conversations: parties read" ON conversations;
--> statement-breakpoint
CREATE POLICY "conversations: parties read" ON conversations
  FOR SELECT USING (
    msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
    OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
  );
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON conversations FROM anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "messages: parties all" ON messages;
--> statement-breakpoint
DROP POLICY IF EXISTS "messages: parties read" ON messages;
--> statement-breakpoint
CREATE POLICY "messages: parties read" ON messages
  FOR SELECT USING (
    conversation_id IN (
      SELECT id FROM conversations
      WHERE msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
         OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
    )
  );
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON messages FROM anon, authenticated;
--> statement-breakpoint

-- ─── P0-3 order_events: no client inserts ────────────────────────────────────
DROP POLICY IF EXISTS "order_events: parties insert" ON order_events;
--> statement-breakpoint
DROP POLICY IF EXISTS "order_events: admin all" ON order_events;
--> statement-breakpoint
DROP POLICY IF EXISTS "order_events: admin read" ON order_events;
--> statement-breakpoint
CREATE POLICY "order_events: admin read" ON order_events
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON order_events FROM anon, authenticated;
--> statement-breakpoint

-- ─── P0-10 audit_logs: append-only (0019 posture) ────────────────────────────
DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON audit_logs FROM anon, authenticated;
--> statement-breakpoint

-- ─── P0-12 agent_events: detector events are admin-only ──────────────────────
DROP POLICY IF EXISTS "agent_events: self read" ON agent_events;
--> statement-breakpoint
CREATE POLICY "agent_events: self read" ON agent_events
  FOR SELECT USING (
    kind <> 'injection_suspected'
    AND run_id IN (SELECT id FROM agent_runs WHERE user_id = auth_user_id())
  );
