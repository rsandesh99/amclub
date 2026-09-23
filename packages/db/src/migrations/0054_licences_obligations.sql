-- Experience v3 E9b (docs/prd/PRD_EXPERIENCE_V3.md FR-9.5, N45 / F7; gated by
-- D-PRD5). Licences a buyer holds, renewal reminders (60 / 30 / 7 days, once
-- each) and the "What do I need?" routing checklist. Everything here is dark
-- behind agent_settings.obligations_enabled (default false): no route answers
-- and no cron sends while it is off.
--
--   buyer_licences       the buyer's own licences (RLS: owner only; soft delete)
--   order_licence_facts  what the provider recorded on delivering a registration
--                        order (number, expiry); the buyer confirms it into a licence
--   licence_reminders    one row per (licence, threshold) — the idempotency key
--                        licence_id:threshold, so a second cron run sends nothing
--   obligation_rules     activity × state × size band → licence type, each with a
--                        source, reviewer and review date. Anyone reads REVIEWED
--                        rows; writes are service-role (ops, after the CA review).
--                        The seed below is UNREVIEWED: nothing shows until a CA
--                        stamps reviewed_by / reviewed_at.
--
-- Rollback: DROP TABLE licence_reminders, buyer_licences, order_licence_facts,
-- obligation_rules; (additive; the flag stays off).

CREATE TABLE IF NOT EXISTS buyer_licences (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  msme_id          uuid NOT NULL REFERENCES msme_profiles(id),
  licence_type     text NOT NULL,
  licence_number   text CHECK (licence_number IS NULL OR char_length(licence_number) <= 64),
  issued_on        date,
  expires_on       date,
  authority        text CHECK (authority IS NULL OR char_length(authority) <= 120),
  certificate_path text,
  source           text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'order')),
  order_id         uuid REFERENCES orders(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT buyer_licences_dates_check CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on),
  CONSTRAINT buyer_licences_type_check CHECK (licence_type IN ('fssai', 'gst_registration', 'udyam', 'iec', 'factory_licence', 'pollution_consent', 'fire_noc', 'trade_licence', 'shops_establishment', 'trademark', 'professional_tax')),
  CONSTRAINT buyer_licences_order_source_check CHECK ((source = 'order') = (order_id IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS buyer_licences_msme_idx ON buyer_licences (msme_id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS buyer_licences_expiry_idx ON buyer_licences (expires_on) WHERE deleted_at IS NULL AND expires_on IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS buyer_licences_order_once ON buyer_licences (order_id) WHERE order_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
ALTER TABLE buyer_licences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "buyer_licences: owner read" ON buyer_licences;
--> statement-breakpoint
CREATE POLICY "buyer_licences: owner read" ON buyer_licences
  FOR SELECT USING (msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id()));
--> statement-breakpoint
DROP POLICY IF EXISTS "buyer_licences: owner insert" ON buyer_licences;
--> statement-breakpoint
CREATE POLICY "buyer_licences: owner insert" ON buyer_licences
  FOR INSERT WITH CHECK (msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id()) AND source = 'manual');
--> statement-breakpoint
DROP POLICY IF EXISTS "buyer_licences: owner update" ON buyer_licences;
--> statement-breakpoint
CREATE POLICY "buyer_licences: owner update" ON buyer_licences
  FOR UPDATE USING (msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id()))
  WITH CHECK (msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id()));
--> statement-breakpoint
REVOKE ALL ON buyer_licences FROM anon;
--> statement-breakpoint
-- No DELETE grant: removal is soft (deleted_at), rule 4.
GRANT SELECT, INSERT, UPDATE ON buyer_licences TO authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS buyer_licences_set_updated_at ON buyer_licences;
--> statement-breakpoint
CREATE TRIGGER buyer_licences_set_updated_at BEFORE UPDATE ON buyer_licences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS order_licence_facts (
  order_id        uuid PRIMARY KEY REFERENCES orders(id),
  licence_type    text NOT NULL CHECK (licence_type IN ('fssai', 'gst_registration', 'udyam', 'iec', 'factory_licence', 'pollution_consent', 'fire_noc', 'trade_licence', 'shops_establishment', 'trademark', 'professional_tax')),
  licence_number  text NOT NULL CHECK (char_length(licence_number) <= 64),
  issued_on       date,
  expires_on      date,
  authority       text CHECK (authority IS NULL OR char_length(authority) <= 120),
  recorded_by     uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_licence_facts_dates_check CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);
--> statement-breakpoint
-- Read and written only through /api/v1 (service role, party-checked).
ALTER TABLE order_licence_facts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON order_licence_facts FROM anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS order_licence_facts_set_updated_at ON order_licence_facts;
--> statement-breakpoint
CREATE TRIGGER order_licence_facts_set_updated_at BEFORE UPDATE ON order_licence_facts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS licence_reminders (
  licence_id      uuid NOT NULL REFERENCES buyer_licences(id),
  threshold_days  integer NOT NULL CHECK (threshold_days IN (60, 30, 7)),
  sent_at         timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (licence_id, threshold_days)
);
--> statement-breakpoint
ALTER TABLE licence_reminders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON licence_reminders FROM anon, authenticated;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS obligation_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity       text CHECK (activity IS NULL OR activity IN ('manufacturing', 'trade', 'services')),
  state          text,
  size_band      text CHECK (size_band IS NULL OR size_band IN ('1-9', '10-49', '50-249')),
  licence_type   text NOT NULL CHECK (licence_type IN ('fssai', 'gst_registration', 'udyam', 'iec', 'factory_licence', 'pollution_consent', 'fire_noc', 'trade_licence', 'shops_establishment', 'trademark', 'professional_tax')),
  category_slug  text NOT NULL,
  source_url     text NOT NULL CHECK (source_url ~ '^https://'),
  reviewed_by    text,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT obligation_rules_review_pair CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
  CONSTRAINT obligation_rules_uniq UNIQUE NULLS NOT DISTINCT (activity, state, size_band, licence_type)
);
--> statement-breakpoint
ALTER TABLE obligation_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "obligation_rules: read reviewed" ON obligation_rules;
--> statement-breakpoint
CREATE POLICY "obligation_rules: read reviewed" ON obligation_rules FOR SELECT USING (reviewed_at IS NOT NULL);
--> statement-breakpoint
REVOKE ALL ON obligation_rules FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON obligation_rules TO anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS obligation_rules_set_updated_at ON obligation_rules;
--> statement-breakpoint
CREATE TRIGGER obligation_rules_set_updated_at BEFORE UPDATE ON obligation_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- Unreviewed starter rows (national, any size). A CA reviews them against the
-- F7 eval set before obligations_enabled turns on; until then none is readable.
INSERT INTO obligation_rules (activity, state, size_band, licence_type, category_slug, source_url) VALUES
  (NULL,            NULL, NULL, 'gst_registration',    'company-registrations', 'https://www.gst.gov.in/'),
  (NULL,            NULL, NULL, 'udyam',               'company-registrations', 'https://udyamregistration.gov.in/'),
  (NULL,            NULL, NULL, 'shops_establishment', 'government-licensing',  'https://labour.gov.in/'),
  (NULL,            NULL, NULL, 'professional_tax',    'tax-accounting',        'https://www.india.gov.in/'),
  ('manufacturing', NULL, NULL, 'factory_licence',     'government-licensing',  'https://labour.gov.in/'),
  ('manufacturing', NULL, NULL, 'pollution_consent',   'government-licensing',  'https://cpcb.nic.in/'),
  ('manufacturing', NULL, NULL, 'fire_noc',            'government-licensing',  'https://www.india.gov.in/'),
  ('trade',         NULL, NULL, 'trade_licence',       'government-licensing',  'https://www.india.gov.in/'),
  ('trade',         NULL, NULL, 'iec',                 'company-registrations', 'https://www.dgft.gov.in/'),
  ('services',      NULL, NULL, 'trade_licence',       'government-licensing',  'https://www.india.gov.in/')
ON CONFLICT ON CONSTRAINT obligation_rules_uniq DO NOTHING;
