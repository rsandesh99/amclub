-- Security hotfix — RLS hardening for messages, order_events, audit_logs,
-- msme_profiles (docs/USER_EXPECTATIONS_AUDIT.md P0-2, P0-3, P0-10, P0-8).
--
-- Before:
--   * "messages: parties all" was FOR ALL → either party of a conversation
--     could UPDATE (e.g. un-redact) or DELETE the other side's messages from
--     the client SDK with the anon key + their own JWT.
--   * "order_events: parties insert" let either party INSERT any event type
--     with any actor_id into their own order timeline (a forged
--     `payout_paid` / `manual_refund` row).
--   * audit_logs had no append-only trigger and client roles kept the
--     default INSERT/UPDATE/DELETE grants (only RLS stood in the way).
--
--   * "msme_profiles: owner all" was FOR ALL → a suspended buyer could clear
--     their own deleted_at (see the msme_profiles section below).
--
-- After: parties are SELECT-only on messages and order_events, owners are
-- SELECT-only on msme_profiles; client roles hold no INSERT/UPDATE/DELETE on
-- messages, order_events, audit_logs or msme_profiles.
-- Every legitimate writer already uses the service role (verified by grep):
--   messages     — api/v1/quotes/[quoteId]/messages POST (admin client)
--   order_events — lib/orders/transitions.ts, lib/mart/goods-transitions.ts,
--                  lib/payments/{payout,materialize}.ts, lib/disputes/resolve.ts,
--                  api/v1/orders/[id]/{transition,milestones,documents,external-wait},
--                  api/v1/admin/{orders,payouts}, api/v1/mart/admin/orders/[id]/documents
--                  (all admin client) + materialize_order() (SECURITY DEFINER)
--   audit_logs   — lib/audit/log.ts, lib/reviews/anomaly.ts,
--                  api/v1/admin/reviews/[id], api/v1/reviews/[id]/flag (admin client)
-- The service role keeps its grants (the kill-test cleanup scripts DELETE with
-- it — the same posture 0016/0019 chose). audit_logs gains the same BEFORE
-- UPDATE guard as order_events (raise_append_only() from 0017 — not recreated).
--
-- Rollback (reopens P0-2/3/10 — not recommended):
--   DROP POLICY "messages: parties read" ON messages;
--   CREATE POLICY "messages: parties all" ON messages FOR ALL USING (<parties>);
--   GRANT INSERT, UPDATE, DELETE ON messages TO authenticated;
--   CREATE POLICY "order_events: parties insert" ON order_events FOR INSERT
--     WITH CHECK (<parties>);  GRANT INSERT ON order_events TO authenticated;
--   DROP TRIGGER audit_logs_no_update ON audit_logs;
--   GRANT INSERT, UPDATE, DELETE ON audit_logs TO authenticated;
--   DROP POLICY "msme_profiles: owner read" ON msme_profiles;
--   CREATE POLICY "msme_profiles: owner all" ON msme_profiles FOR ALL
--     USING (user_id = auth_user_id()) WITH CHECK (user_id = auth_user_id());
--   GRANT INSERT, UPDATE, DELETE ON msme_profiles TO authenticated;
-- (<parties> = the conversation/order party predicate as it was in
-- rls/policies.sql before this change.) No data is touched, so rollback is
-- grants/policies only.

-- ─── messages: parties read-only ─────────────────────────────────────────────
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

-- ─── order_events: no client inserts ─────────────────────────────────────────
-- UPDATE/DELETE were revoked in 0019; this closes INSERT.
DROP POLICY IF EXISTS "order_events: parties insert" ON order_events;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON order_events FROM anon, authenticated;
--> statement-breakpoint

-- ─── audit_logs: append-only, service-role writes only ───────────────────────
DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON audit_logs FROM anon, authenticated;
--> statement-breakpoint

-- ─── msme_profiles: owner read-only (P0-8 suspension bypass) ─────────────────
-- "msme_profiles: owner all" let a suspended buyer clear their own deleted_at
-- (or hard-delete the row and re-sign-up clean), and self-set udyam_verified /
-- gstin_verified. Every writer is the service role (profile/msme POST upsert,
-- admin/msmes suspend/reactivate, kyc/verify-udyam), so the owner keeps SELECT only.
DROP POLICY IF EXISTS "msme_profiles: owner all" ON msme_profiles;
--> statement-breakpoint
DROP POLICY IF EXISTS "msme_profiles: owner read" ON msme_profiles;
--> statement-breakpoint
CREATE POLICY "msme_profiles: owner read" ON msme_profiles
  FOR SELECT USING (user_id = auth_user_id());
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON msme_profiles FROM anon, authenticated;
