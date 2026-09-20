-- WhatsApp rails (BUILD_PROMPTS S0.5) — additive, idempotent, NOT staged
-- (apply to prod before/with the writer, RULES.md 2).
--
-- wa_conversations: one row per phone (E.164 digits, no '+'), bound to a user
-- when the phone matches users.phone; tracks the 24h customer-care window.
-- wa_messages: every inbound/outbound message, idempotent on vendor_message_id
-- (webhook replays are no-ops). Media bytes live in the private `wa-media`
-- storage bucket; media_ref is the object path.
--
-- RLS: NO client policies (the runtime + web write via service role; nothing
-- here is a user-facing read surface yet). Admin/ops read for support tooling.

CREATE TABLE IF NOT EXISTS wa_conversations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164         text NOT NULL UNIQUE,
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  locale             text NOT NULL DEFAULT 'en',
  last_inbound_at    timestamptz,
  last_outbound_at   timestamptz,
  -- Meta/BSP customer-care window: 24h after the last inbound message.
  window_open_until  timestamptz,
  -- Holding reply throttle (S0.5: "we'll get back" at most once per 24h).
  last_holding_reply_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS wa_conversations_user_idx ON wa_conversations (user_id) WHERE user_id IS NOT NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS wa_conversations_set_updated_at ON wa_conversations;
--> statement-breakpoint
CREATE TRIGGER wa_conversations_set_updated_at
  BEFORE UPDATE ON wa_conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE wa_conversations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "wa_conversations: admin read" ON wa_conversations;
--> statement-breakpoint
CREATE POLICY "wa_conversations: admin read" ON wa_conversations
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON wa_conversations FROM anon, authenticated;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS wa_messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id    uuid NOT NULL REFERENCES wa_conversations(id) ON DELETE CASCADE,
  direction          text NOT NULL CHECK (direction IN ('in', 'out')),
  -- idempotency key for webhook replays (vendor ids are globally unique)
  vendor_message_id  text UNIQUE,
  kind               text NOT NULL CHECK (kind IN ('text', 'audio', 'image', 'document', 'button', 'template', 'unknown')),
  body               text,
  -- storage object path in the private wa-media bucket
  media_ref          text,
  mime               text,
  template_name      text,
  status             text NOT NULL DEFAULT 'received'
                     CHECK (status IN ('sent', 'delivered', 'read', 'failed', 'received', 'stub')),
  payload            jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS wa_messages_conversation_created_idx ON wa_messages (conversation_id, created_at DESC);
--> statement-breakpoint
ALTER TABLE wa_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "wa_messages: admin read" ON wa_messages;
--> statement-breakpoint
CREATE POLICY "wa_messages: admin read" ON wa_messages
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON wa_messages FROM anon, authenticated;
