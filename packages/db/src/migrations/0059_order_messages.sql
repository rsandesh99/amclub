-- Experience v3 E8b (docs/prd/PRD_EXPERIENCE_V3.md FR-8.4, N24) — order messaging.
--
-- Decision (the implementation plan): order threads reuse the existing
-- conversations / messages model with context_type = 'order' (the column has
-- always allowed 'order'; one conversation per order via
-- conversations_context_uniq). No new table.
--
--   1. conversations: parties READ only (was FOR ALL). The one writer for
--      both quote and order threads is the service-role route, which masks
--      contact details first (redactContactInfo) — a party can no longer
--      create, retarget or delete a conversation row directly. No client code
--      wrote conversations (grep: routes use the admin client).
--   2. Admin / ops read both tables (FR-8.4 "RLS for the parties + admin").
--   3. messages_conversation_created_idx for the thread read and the unread count.
--
-- rls/policies.sql carries the same policies.
--
-- Rollback: DROP POLICY "conversations: parties read" / the two admin read
-- policies; CREATE POLICY "conversations: parties all" ON conversations FOR ALL
-- USING (<parties>); GRANT INSERT, UPDATE, DELETE ON conversations TO authenticated;
-- DROP INDEX messages_conversation_created_idx.

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
DROP POLICY IF EXISTS "conversations: admin read" ON conversations;
--> statement-breakpoint
CREATE POLICY "conversations: admin read" ON conversations
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
DROP POLICY IF EXISTS "messages: admin read" ON messages;
--> statement-breakpoint
CREATE POLICY "messages: admin read" ON messages
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages (conversation_id, created_at);
