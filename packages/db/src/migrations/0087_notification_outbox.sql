-- 0087 — notification outbox, preferences, reminders and DPDP requests (ADR-030 §4–§6). NOT staged; additive,
-- idempotent. Server-written only; users read their own preferences and requests.
--
--   notification_preferences  per (user, category, channel) switch; absent row = the kind's default channels.
--   notification_settings     quiet hours (IST), a pause, and the providers' lead digest.
--   notification_outbox       one row per (notification, channel): the dispatcher's queue with retry, deferral for
--                             quiet hours and fallback links (a failed WhatsApp → SMS / email). Closes audit M37.
--   notification_reminders    idempotent claim per (kind, entity, stage) so a reminder cron sends each reminder once.
--   dpdp_requests             data-principal requests (access / correction / erasure / withdrawal / grievance) from the
--                             web, mobile and WhatsApp, with the statutory due date.
--
-- The dispatcher keeps working without this migration (it falls back to the direct send it had before 0087), so the
-- code can ship first. Rollback: DROP TABLE dpdp_requests, notification_reminders, notification_outbox,
-- notification_settings, notification_preferences.

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    text NOT NULL CHECK (category IN ('orders', 'payments', 'requests', 'reminders', 'account', 'assistant', 'updates')),
  channel     text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'push')),
  enabled     boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category, channel)
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS notification_preferences_set_updated_at ON notification_preferences;
--> statement-breakpoint
CREATE TRIGGER notification_preferences_set_updated_at BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS notification_settings (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- IST minute of day; both null = no quiet hours
  quiet_start_min  smallint CHECK (quiet_start_min BETWEEN 0 AND 1439),
  quiet_end_min    smallint CHECK (quiet_end_min BETWEEN 0 AND 1439),
  paused_until     timestamptz,
  digest_leads     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((quiet_start_min IS NULL) = (quiet_end_min IS NULL))
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS notification_settings_set_updated_at ON notification_settings;
--> statement-breakpoint
CREATE TRIGGER notification_settings_set_updated_at BEFORE UPDATE ON notification_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS notification_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id  uuid REFERENCES notifications(id) ON DELETE SET NULL,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             text NOT NULL,
  channel          text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'push')),
  -- the rendered message per the recipient's locale (title, body, link, template params); no secrets
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped', 'deferred', 'fallback')),
  attempts         smallint NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  claimed_until    timestamptz,
  last_error       text,
  detail           text,
  -- the row this one replaces (a WhatsApp that failed → this SMS)
  fallback_of      uuid REFERENCES notification_outbox(id) ON DELETE SET NULL,
  idempotency_key  text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_outbox_due_idx ON notification_outbox (next_attempt_at)
  WHERE status IN ('queued', 'deferred', 'sending');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_outbox_user_idx ON notification_outbox (user_id, created_at DESC);
--> statement-breakpoint
DROP TRIGGER IF EXISTS notification_outbox_set_updated_at ON notification_outbox;
--> statement-breakpoint
CREATE TRIGGER notification_outbox_set_updated_at BEFORE UPDATE ON notification_outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS notification_reminders (
  kind        text NOT NULL,
  entity_id   uuid NOT NULL,
  stage       text NOT NULL,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, entity_id, stage)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS dpdp_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  phone_e164   text,
  kind         text NOT NULL CHECK (kind IN ('access', 'correction', 'erasure', 'withdrawal', 'grievance', 'nomination')),
  source       text NOT NULL CHECK (source IN ('web', 'mobile', 'whatsapp', 'email', 'admin')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'rejected')),
  details      text,
  resolution   text,
  due_at       timestamptz NOT NULL,
  resolved_at  timestamptz,
  resolved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dpdp_requests_open_idx ON dpdp_requests (due_at) WHERE status IN ('open', 'in_progress') AND deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dpdp_requests_user_idx ON dpdp_requests (user_id, created_at DESC) WHERE user_id IS NOT NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dpdp_requests_set_updated_at ON dpdp_requests;
--> statement-breakpoint
CREATE TRIGGER dpdp_requests_set_updated_at BEFORE UPDATE ON dpdp_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ── grants (ADR-025) ─────────────────────────────────────────────────────────
REVOKE ALL ON notification_preferences, notification_settings, notification_outbox, notification_reminders, dpdp_requests FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON notification_preferences, notification_settings, dpdp_requests TO authenticated;
--> statement-breakpoint
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_reminders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE dpdp_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "notification_preferences: self read" ON notification_preferences;
--> statement-breakpoint
CREATE POLICY "notification_preferences: self read" ON notification_preferences FOR SELECT USING (user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "notification_settings: self read" ON notification_settings;
--> statement-breakpoint
CREATE POLICY "notification_settings: self read" ON notification_settings FOR SELECT USING (user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "dpdp_requests: self read" ON dpdp_requests;
--> statement-breakpoint
CREATE POLICY "dpdp_requests: self read" ON dpdp_requests FOR SELECT USING (user_id = auth_user_id() AND deleted_at IS NULL);
