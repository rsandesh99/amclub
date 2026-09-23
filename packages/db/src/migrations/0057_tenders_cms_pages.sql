-- Experience v3 E11c (docs/prd/PRD_EXPERIENCE_V3.md FR-11.6, N30; gated by D9
-- and its own §8.1 mini-PRD). Dark behind agent_settings.tenders_enabled.
--
--   tender_alerts    government tender notices (title, department, value band,
--                    closing date, the official portal link) matched to
--                    providers by category + state. ALERTS ONLY: there is no
--                    bid, apply or submit anywhere in AMClub. Filled by an
--                    import whose data source and licence the D9 mini-PRD
--                    decides; service role only.
--   tender_feedback  a provider's "Save" / "Not relevant" (feeds matching).
--   cms_pages        reviewed content pages (first: the GeM seller checklist).
--                    Anyone reads a page reviewed within the last 180 days; a
--                    stale or unreviewed page is invisible until re-reviewed.
--
-- Rollback: DROP TABLE tender_feedback, tender_alerts, cms_pages;

CREATE TABLE IF NOT EXISTS tender_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text NOT NULL,
  source_ref      text NOT NULL,
  title           text NOT NULL CHECK (char_length(title) <= 300),
  department      text NOT NULL CHECK (char_length(department) <= 200),
  value_band      text CHECK (value_band IS NULL OR value_band IN ('under_5l', '5l_to_25l', '25l_to_1cr', 'over_1cr')),
  closes_on       date NOT NULL,
  portal_url      text NOT NULL CHECK (portal_url ~ '^https://'),
  category_slugs  text[] NOT NULL DEFAULT '{}',
  states          text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT tender_alerts_source_uniq UNIQUE (source, source_ref)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tender_alerts_open_idx ON tender_alerts (closes_on) WHERE deleted_at IS NULL;
--> statement-breakpoint
ALTER TABLE tender_alerts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON tender_alerts FROM anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tender_alerts_set_updated_at ON tender_alerts;
--> statement-breakpoint
CREATE TRIGGER tender_alerts_set_updated_at BEFORE UPDATE ON tender_alerts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS tender_feedback (
  provider_id  uuid NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  alert_id     uuid NOT NULL REFERENCES tender_alerts(id) ON DELETE CASCADE,
  verdict      text NOT NULL CHECK (verdict IN ('saved', 'not_relevant')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, alert_id)
);
--> statement-breakpoint
ALTER TABLE tender_feedback ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON tender_feedback FROM anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tender_feedback_set_updated_at ON tender_feedback;
--> statement-breakpoint
CREATE TRIGGER tender_feedback_set_updated_at BEFORE UPDATE ON tender_feedback
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS cms_pages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,80}$'),
  title_i18n   jsonb NOT NULL,
  body_i18n    jsonb NOT NULL,
  reviewed_by  text,
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT cms_pages_review_pair CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL))
);
--> statement-breakpoint
ALTER TABLE cms_pages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "cms_pages: read fresh reviewed" ON cms_pages;
--> statement-breakpoint
CREATE POLICY "cms_pages: read fresh reviewed" ON cms_pages FOR SELECT
  USING (deleted_at IS NULL AND reviewed_at IS NOT NULL AND reviewed_at > now() - interval '180 days');
--> statement-breakpoint
REVOKE ALL ON cms_pages FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON cms_pages TO anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS cms_pages_set_updated_at ON cms_pages;
--> statement-breakpoint
CREATE TRIGGER cms_pages_set_updated_at BEFORE UPDATE ON cms_pages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- The GeM seller checklist (from the market survey). UNREVIEWED: invisible until someone stamps it.
INSERT INTO cms_pages (slug, title_i18n, body_i18n) VALUES (
  'gem-seller-checklist',
  '{"en":"GeM seller checklist","hi":"GeM विक्रेता चेकलिस्ट","te":"GeM విక్రేత చెక్‌లిస్ట్","ta":"GeM விற்பனையாளர் சரிபார்ப்புப் பட்டியல்"}',
  '{"en":["Aadhaar-linked mobile and PAN of the authorised signatory","Udyam or MSME certificate (for MSE preferences)","GSTIN and the last filed return","Bank account with a cancelled cheque (PFMS-validated)","OEM authorisation or reseller documents for branded products","Past work orders and invoices for experience criteria","Digital signature certificate (Class 3) for bids","Vendor assessment, where the category requires it"],"hi":["अधिकृत हस्ताक्षरकर्ता का आधार-लिंक्ड मोबाइल और PAN","उद्यम या MSME प्रमाणपत्र (MSE वरीयता के लिए)","GSTIN और अंतिम दाखिल रिटर्न","रद्द चेक के साथ बैंक खाता (PFMS-सत्यापित)","ब्रांडेड उत्पादों के लिए OEM प्राधिकरण या पुनर्विक्रेता दस्तावेज़","अनुभव मानदंड के लिए पिछले कार्य आदेश और चालान","बोली के लिए डिजिटल हस्ताक्षर प्रमाणपत्र (क्लास 3)","जहाँ श्रेणी में आवश्यक हो, विक्रेता मूल्यांकन"]}'
) ON CONFLICT (slug) DO NOTHING;
