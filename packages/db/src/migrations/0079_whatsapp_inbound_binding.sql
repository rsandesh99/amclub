-- 0079 — WhatsApp inbound bookkeeping + phone-bound conversations (architecture + security audit,
-- 2026-09-24: M33, M41). Agent migration: additive, idempotent, NOT staged — apply before (or with) the
-- runtime deploy that writes processed_at. The runtime tolerates its absence (it stores without the column,
-- logs once, and /health reports the sweep as failed).
--
-- M33 — wa_messages.processed_at: the wa.inbound job stamps it when the dispatcher finished. The runtime's
-- minute sweep re-enqueues inbound rows still NULL after a minute (the job id is the message id, so a message
-- whose job exists is never processed twice). DEFAULT now(): every existing row, and every row written by
-- anything but the new webhook (outbound rows, the verify rigs, an older runtime), counts as processed and is
-- never re-driven; the webhook inserts processed_at = NULL explicitly.
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS processed_at timestamptz DEFAULT now();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS wa_messages_unprocessed_in_idx ON wa_messages (created_at) WHERE direction = 'in' AND processed_at IS NULL;
--> statement-breakpoint

-- M41 — a conversation is ONE phone and acts for a user only while that user's users.phone IS that phone.
-- When users.phone changes, the user's conversations on any other phone are unbound (and their routes to an
-- onboarding session / support ticket / procurement session cleared), and the WhatsApp grants given from a phone
-- that is no longer theirs are revoked — consent belongs to the phone. The runtime re-derives the owner on every
-- inbound message as well (whatsapp/binding.ts); this closes the gap before the next message arrives.
CREATE OR REPLACE FUNCTION wa_unbind_on_phone_change() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  new_digits text := regexp_replace(coalesce(NEW.phone, ''), '\D', '', 'g');
BEGIN
  IF regexp_replace(coalesce(OLD.phone, ''), '\D', '', 'g') = new_digits THEN
    RETURN NEW;
  END IF;
  UPDATE wa_conversations
     SET user_id = NULL,
         active_session_id = NULL,
         support_ticket_id = NULL,
         procurement_session_id = NULL,
         updated_at = now()
   WHERE user_id = NEW.id
     AND phone_e164 IS DISTINCT FROM new_digits;
  UPDATE agent_grants
     SET revoked_at = now()
   WHERE user_id = NEW.id
     AND channel = 'whatsapp'
     AND revoked_at IS NULL
     AND (new_digits = '' OR regexp_replace(coalesce(channel_identity, ''), '\D', '', 'g') IS DISTINCT FROM new_digits);
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION wa_unbind_on_phone_change() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS users_phone_change_wa_unbind ON users;
--> statement-breakpoint
CREATE TRIGGER users_phone_change_wa_unbind
  AFTER UPDATE OF phone ON users
  FOR EACH ROW EXECUTE FUNCTION wa_unbind_on_phone_change();
