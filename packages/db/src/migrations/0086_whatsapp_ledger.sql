-- 0086 — WhatsApp on the Cloud API: consent ledger, delivery ledger, templates, account events (ADR-030). NOT staged;
-- additive and idempotent. Every table is server-written only (ADR-018 / ADR-025): no client INSERT / UPDATE / DELETE.
--
--   wa_consent_events   append-only: every opt-in / opt-out, per phone and purpose, with source, notice version, the
--                       keyword or button actually used and the inbound message id (DPDP s.6(10) proof).
--   wa_phone_consents   the current state per (phone, purpose), written only by record_wa_consent() with its event.
--   wa_suppressions     delivery-driven suppression (not on WhatsApp, stopped marketing, blocked) from error codes.
--   wa_messages         + the outbound ledger columns: idempotency key, user, notification, run, template language,
--                       category, error code, billing, cost in millipaise (1/1000 paise, rule 6: integers only),
--                       status time, transcript cache, retention markers; statuses never move backwards.
--   wa_conversations    + business-scoped user id (BSUID), the 72-hour free-entry window, first referral, bind time.
--   wa_templates        the template registry mirrored from Meta (category, status, rejection reason).
--   wa_account_events   template status / category, phone quality and account webhooks, stored as received.
--
-- Rollback: DROP TRIGGER users_phone_change_wa_consent ON users; DROP FUNCTION wa_consent_on_phone_change, record_wa_consent; DROP TABLE wa_account_events, wa_templates, wa_suppressions,
-- wa_phone_consents, wa_consent_events; the added columns are nullable / defaulted and can stay.

-- ── wa_conversations ────────────────────────────────────────────────────────
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS bsuid text;
--> statement-breakpoint
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS entry_window_until timestamptz;
--> statement-breakpoint
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS first_referral jsonb;
--> statement-breakpoint
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS bound_at timestamptz;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS wa_conversations_bsuid_uniq ON wa_conversations (bsuid) WHERE bsuid IS NOT NULL;
--> statement-breakpoint

-- ── wa_messages: the outbound ledger ────────────────────────────────────────
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS notification_kind text;
--> statement-breakpoint
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS notification_id uuid;
--> statement-breakpoint
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS run_id uuid;
--> statement-breakpoint
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS idempotency_key text;
--> statement-breakpoint
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS template_language text;
--> statement-breakpoint
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS category text;
--> statement-breakpoint
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS error_code integer;
--> statement-breakpoint
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS error_title text;
--> statement-breakpoint
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS billable boolean;
--> statement-breakpoint
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS pricing_category text;
--> statement-breakpoint
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS cost_millipaise bigint;
--> statement-breakpoint
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS status_at timestamptz;
--> statement-breakpoint
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS transcript text;
--> statement-breakpoint
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS redacted_at timestamptz;
--> statement-breakpoint
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS legal_hold boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS wa_messages_idempotency_uniq ON wa_messages (idempotency_key) WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS wa_messages_user_created_idx ON wa_messages (user_id, created_at DESC) WHERE user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS wa_messages_retention_idx ON wa_messages (created_at) WHERE redacted_at IS NULL AND legal_hold = false;
--> statement-breakpoint
ALTER TABLE wa_messages DROP CONSTRAINT IF EXISTS wa_messages_kind_check;
--> statement-breakpoint
ALTER TABLE wa_messages ADD CONSTRAINT wa_messages_kind_check CHECK (kind IN (
  'text', 'audio', 'image', 'document', 'video', 'sticker', 'location', 'contacts', 'reaction', 'order', 'system',
  'interactive', 'button', 'template', 'flow_reply', 'unknown'));
--> statement-breakpoint
ALTER TABLE wa_messages DROP CONSTRAINT IF EXISTS wa_messages_status_check;
--> statement-breakpoint
ALTER TABLE wa_messages ADD CONSTRAINT wa_messages_status_check CHECK (status IN (
  'queued', 'sent', 'delivered', 'read', 'failed', 'received', 'stub', 'skipped'));
--> statement-breakpoint
-- Meta's status webhooks can arrive out of order: a late "sent" or "delivered" never overwrites "read", a late "sent"
-- never overwrites "delivered", and nothing leaves "failed" except a later successful state from a retry of the same
-- row (delivered / read).
CREATE OR REPLACE FUNCTION wa_messages_status_forward() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  rank_old int := CASE OLD.status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE -1 END;
  rank_new int := CASE NEW.status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE -1 END;
BEGIN
  IF rank_old >= 0 AND rank_new >= 0 AND rank_new < rank_old THEN
    NEW.status := OLD.status;
    NEW.status_at := OLD.status_at;
  ELSIF OLD.status = 'failed' AND NEW.status IN ('queued', 'sent') THEN
    NEW.status := OLD.status;
    NEW.status_at := OLD.status_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION wa_messages_status_forward() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS wa_messages_status_forward ON wa_messages;
--> statement-breakpoint
CREATE TRIGGER wa_messages_status_forward BEFORE UPDATE ON wa_messages
  FOR EACH ROW EXECUTE FUNCTION wa_messages_status_forward();
--> statement-breakpoint

-- ── consent ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_consent_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- E.164 digits without '+', as wa_conversations.phone_e164
  phone_e164        text NOT NULL,
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  purpose           text NOT NULL CHECK (purpose IN ('transactional', 'assistant', 'marketing')),
  action            text NOT NULL CHECK (action IN ('opt_in', 'opt_out')),
  source            text NOT NULL CHECK (source IN ('whatsapp_keyword', 'whatsapp_button', 'web_settings', 'mobile_settings', 'signup', 'checkout', 'ctwa', 'admin', 'system')),
  notice_version    text,
  keyword           text,
  vendor_message_id text,
  locale            text,
  ip                text,
  user_agent        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS wa_consent_events_phone_idx ON wa_consent_events (phone_e164, purpose, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS wa_consent_events_user_idx ON wa_consent_events (user_id, created_at DESC) WHERE user_id IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wa_consent_events_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- the only permitted change is ON DELETE SET NULL of user_id when the user row goes (erasure keeps the phone evidence)
  IF TG_OP = 'UPDATE' AND NEW.user_id IS NULL AND OLD.user_id IS NOT NULL
     AND (to_jsonb(NEW) - 'user_id' - 'updated_at') = (to_jsonb(OLD) - 'user_id' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'wa_consent_events is append-only' USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION wa_consent_events_append_only() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS wa_consent_events_append_only ON wa_consent_events;
--> statement-breakpoint
CREATE TRIGGER wa_consent_events_append_only BEFORE UPDATE OR DELETE ON wa_consent_events
  FOR EACH ROW EXECUTE FUNCTION wa_consent_events_append_only();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS wa_phone_consents (
  phone_e164    text NOT NULL,
  purpose       text NOT NULL CHECK (purpose IN ('transactional', 'assistant', 'marketing')),
  status        text NOT NULL CHECK (status IN ('opted_in', 'opted_out')),
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  last_event_id uuid NOT NULL REFERENCES wa_consent_events(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (phone_e164, purpose)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS wa_phone_consents_user_idx ON wa_phone_consents (user_id) WHERE user_id IS NOT NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS wa_phone_consents_set_updated_at ON wa_phone_consents;
--> statement-breakpoint
CREATE TRIGGER wa_phone_consents_set_updated_at BEFORE UPDATE ON wa_phone_consents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- The ONE writer of consent: one event per purpose, then the current state, in one transaction. Service role only.
-- p_phone is normalised to digits. Returns the number of purposes whose state changed.
CREATE OR REPLACE FUNCTION record_wa_consent(
  p_phone text, p_user_id uuid, p_purposes text[], p_action text, p_source text,
  p_notice_version text DEFAULT NULL, p_keyword text DEFAULT NULL, p_vendor_message_id text DEFAULT NULL,
  p_locale text DEFAULT NULL, p_ip text DEFAULT NULL, p_user_agent text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_phone text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_purpose text;
  v_event uuid;
  v_status text := CASE p_action WHEN 'opt_in' THEN 'opted_in' WHEN 'opt_out' THEN 'opted_out' END;
  v_prior text;
  v_changed integer := 0;
BEGIN
  IF v_phone !~ '^\d{8,15}$' THEN RAISE EXCEPTION 'record_wa_consent: bad phone' USING ERRCODE = 'check_violation'; END IF;
  IF v_status IS NULL THEN RAISE EXCEPTION 'record_wa_consent: bad action' USING ERRCODE = 'check_violation'; END IF;
  IF coalesce(array_length(p_purposes, 1), 0) = 0 THEN RAISE EXCEPTION 'record_wa_consent: no purpose' USING ERRCODE = 'check_violation'; END IF;
  FOREACH v_purpose IN ARRAY p_purposes LOOP
    INSERT INTO wa_consent_events AS e (phone_e164, user_id, purpose, action, source, notice_version, keyword, vendor_message_id, locale, ip, user_agent)
    VALUES (v_phone, p_user_id, v_purpose, p_action, p_source, p_notice_version, left(p_keyword, 60), p_vendor_message_id, p_locale, p_ip, left(p_user_agent, 300))
    RETURNING e.id INTO v_event;
    SELECT c.status INTO v_prior FROM wa_phone_consents c WHERE c.phone_e164 = v_phone AND c.purpose = v_purpose FOR UPDATE;
    IF v_prior IS DISTINCT FROM v_status THEN v_changed := v_changed + 1; END IF;
    INSERT INTO wa_phone_consents AS c (phone_e164, purpose, status, user_id, last_event_id)
    VALUES (v_phone, v_purpose, v_status, p_user_id, v_event)
    ON CONFLICT (phone_e164, purpose) DO UPDATE
      SET status = EXCLUDED.status, user_id = coalesce(EXCLUDED.user_id, c.user_id), last_event_id = EXCLUDED.last_event_id;
  END LOOP;
  RETURN v_changed;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION record_wa_consent(text, uuid, text[], text, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION record_wa_consent(text, uuid, text[], text, text, text, text, text, text, text, text) TO service_role;
--> statement-breakpoint

-- Consent belongs to the phone AND the person who gave it. When a user's phone changes, what they opted into on the
-- old number is withdrawn (event source `system`, keyword `phone_change`): a recycled number reaching a new owner
-- starts with no consent. Runs beside 0079's unbind trigger; the send path also requires the consent's user to be the
-- recipient (agent-core mayMessage).
CREATE OR REPLACE FUNCTION wa_consent_on_phone_change() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old text := regexp_replace(coalesce(OLD.phone, ''), '\D', '', 'g');
  v_purposes text[];
BEGIN
  IF v_old = regexp_replace(coalesce(NEW.phone, ''), '\D', '', 'g') OR v_old !~ '^\d{8,15}$' THEN RETURN NULL; END IF;
  SELECT array_agg(c.purpose ORDER BY c.purpose) INTO v_purposes
    FROM wa_phone_consents c
   WHERE c.phone_e164 = v_old AND c.status = 'opted_in' AND (c.user_id = OLD.id OR c.user_id IS NULL);
  IF v_purposes IS NOT NULL THEN
    PERFORM record_wa_consent(v_old, OLD.id, v_purposes, 'opt_out', 'system', NULL, 'phone_change');
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION wa_consent_on_phone_change() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS users_phone_change_wa_consent ON users;
--> statement-breakpoint
CREATE TRIGGER users_phone_change_wa_consent
  AFTER UPDATE OF phone ON users
  FOR EACH ROW EXECUTE FUNCTION wa_consent_on_phone_change();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS wa_suppressions (
  phone_e164  text PRIMARY KEY,
  reason      text NOT NULL CHECK (reason IN ('not_on_whatsapp', 'marketing_stopped', 'undeliverable', 'blocked', 'admin')),
  error_code  integer,
  -- null = until cleared; marketing_stopped / undeliverable carry an expiry so a later retry is possible
  until       timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS wa_suppressions_set_updated_at ON wa_suppressions;
--> statement-breakpoint
CREATE TRIGGER wa_suppressions_set_updated_at BEFORE UPDATE ON wa_suppressions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ── templates and account events ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_templates (
  name              text NOT NULL,
  language          text NOT NULL,
  category          text CHECK (category IN ('utility', 'marketing', 'authentication')),
  status            text NOT NULL DEFAULT 'unknown'
                    CHECK (status IN ('unknown', 'pending', 'approved', 'rejected', 'paused', 'disabled', 'in_appeal', 'deleted')),
  rejection_reason  text,
  meta_template_id  text,
  components        jsonb,
  quality           text,
  synced_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, language)
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS wa_templates_set_updated_at ON wa_templates;
--> statement-breakpoint
CREATE TRIGGER wa_templates_set_updated_at BEFORE UPDATE ON wa_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS wa_account_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field       text NOT NULL,
  entry_id    text,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS wa_account_events_field_idx ON wa_account_events (field, created_at DESC);
--> statement-breakpoint

-- ── grants (ADR-025: an explicit decision for every new table) ───────────────
REVOKE ALL ON wa_consent_events, wa_phone_consents, wa_suppressions, wa_templates, wa_account_events FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON wa_consent_events, wa_phone_consents TO authenticated;
--> statement-breakpoint
ALTER TABLE wa_consent_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE wa_phone_consents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE wa_suppressions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE wa_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE wa_account_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "wa_consent_events: self read" ON wa_consent_events;
--> statement-breakpoint
CREATE POLICY "wa_consent_events: self read" ON wa_consent_events FOR SELECT USING (user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "wa_phone_consents: self read" ON wa_phone_consents;
--> statement-breakpoint
CREATE POLICY "wa_phone_consents: self read" ON wa_phone_consents FOR SELECT USING (user_id = auth_user_id());
