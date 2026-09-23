-- Experience v3 E6 — requirements v3 (docs/prd/PRD_EXPERIENCE_V3.md §6 E6).
-- Additive; the requirement form's v3 UI is behind EXP_V3_REQUIREMENTS.
--
-- 1. rfqs.must_haves (FR-6.4, N19 / F2): { credentials, languages, onSite,
--    inStateOnly } shown to providers. NOT used by fan-out (D-PRD6).
-- 2. service_document_requirements (FR-6.3): "documents you'll likely need",
--    per category (+ optional service). Public read; service-role writes. The
--    seeded rows are UNREVIEWED (reviewed_at NULL) — the form shows only rows
--    a CA / lawyer has stamped, and only while document_suggestions_enabled.
-- 3. quote_sla_stats (FR-6.5, N38): median first-quote minutes per category ×
--    buyer state over 90 days, refreshed nightly by refresh_quote_sla_stats()
--    (service role). Public read: aggregates only, never an RFQ or a quote.
--
-- Rollback: DROP FUNCTION refresh_quote_sla_stats(); DROP TABLE quote_sla_stats;
-- DROP TABLE service_document_requirements; ALTER TABLE rfqs DROP CONSTRAINT
-- rfqs_must_haves_check, DROP COLUMN must_haves;

ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS must_haves jsonb;
--> statement-breakpoint
ALTER TABLE rfqs DROP CONSTRAINT IF EXISTS rfqs_must_haves_check;
--> statement-breakpoint
ALTER TABLE rfqs ADD CONSTRAINT rfqs_must_haves_check CHECK (must_haves IS NULL OR jsonb_typeof(must_haves) = 'object');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS service_document_requirements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_slug text NOT NULL,
  service_slug  text,
  doc_key       text NOT NULL CHECK (doc_key ~ '^[a-z0-9_]{1,40}$'),
  label_i18n    jsonb NOT NULL,
  required      boolean NOT NULL DEFAULT false,
  note_i18n     jsonb,
  sort_order    integer NOT NULL DEFAULT 0,
  reviewed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,
  deleted_at    timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS service_document_requirements_key_uniq ON service_document_requirements (category_slug, coalesce(service_slug, ''), doc_key);
--> statement-breakpoint
ALTER TABLE service_document_requirements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "service_document_requirements: public read" ON service_document_requirements;
--> statement-breakpoint
CREATE POLICY "service_document_requirements: public read" ON service_document_requirements FOR SELECT USING (deleted_at IS NULL);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON service_document_requirements FROM anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS service_document_requirements_set_updated_at ON service_document_requirements;
--> statement-breakpoint
CREATE TRIGGER service_document_requirements_set_updated_at BEFORE UPDATE ON service_document_requirements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- Seed content (UNREVIEWED). Labels en / hi / te / ta.
INSERT INTO service_document_requirements (category_slug, service_slug, doc_key, label_i18n, required, sort_order) VALUES
  ('company-registrations', NULL, 'pan', '{"en":"PAN of every director / partner","hi":"हर निदेशक / साझेदार का PAN","te":"ప్రతి డైరెక్టర్ / భాగస్వామి PAN","ta":"ஒவ்வொரு இயக்குநர் / கூட்டாளியின் PAN"}', true, 1),
  ('company-registrations', NULL, 'aadhaar', '{"en":"Aadhaar of every director / partner","hi":"हर निदेशक / साझेदार का आधार","te":"ప్రతి డైరెక్టర్ / భాగస్వామి ఆధార్","ta":"ஒவ்வொரு இயக்குநர் / கூட்டாளியின் ஆதார்"}', true, 2),
  ('company-registrations', NULL, 'office_address_proof', '{"en":"Office address proof (rent agreement or utility bill)","hi":"कार्यालय पते का प्रमाण (किराया अनुबंध या बिजली बिल)","te":"కార్యాలయ చిరునామా రుజువు (అద్దె ఒప్పందం లేదా బిల్లు)","ta":"அலுவலக முகவரிச் சான்று (வாடகை ஒப்பந்தம் அல்லது கட்டணச் சீட்டு)"}', true, 3),
  ('company-registrations', NULL, 'owner_noc', '{"en":"NOC from the property owner","hi":"मकान मालिक से NOC","te":"ఆస్తి యజమాని నుండి NOC","ta":"சொத்து உரிமையாளரின் NOC"}', false, 4),
  ('company-registrations', 'gst-registration', 'bank_proof', '{"en":"Cancelled cheque or bank statement","hi":"रद्द किया चेक या बैंक स्टेटमेंट","te":"రద్దు చేసిన చెక్ లేదా బ్యాంక్ స్టేట్‌మెంట్","ta":"ரத்து செய்த காசோலை அல்லது வங்கி அறிக்கை"}', true, 5),
  ('tax-accounting', NULL, 'pan', '{"en":"Business PAN","hi":"व्यवसाय का PAN","te":"వ్యాపార PAN","ta":"வணிக PAN"}', true, 1),
  ('tax-accounting', NULL, 'bank_statements', '{"en":"Bank statements for the period","hi":"अवधि के बैंक स्टेटमेंट","te":"ఆ కాలపు బ్యాంక్ స్టేట్‌మెంట్లు","ta":"அந்தக் காலத்தின் வங்கி அறிக்கைகள்"}', false, 2),
  ('tax-accounting', 'gst-filing', 'gst_login', '{"en":"GST portal login","hi":"GST पोर्टल लॉगिन","te":"GST పోర్టల్ లాగిన్","ta":"GST போர்ட்டல் உள்நுழைவு"}', true, 3),
  ('tax-accounting', 'gst-filing', 'sales_register', '{"en":"Sales and purchase registers","hi":"बिक्री और खरीद रजिस्टर","te":"అమ్మకాలు, కొనుగోళ్ల రిజిస్టర్లు","ta":"விற்பனை மற்றும் கொள்முதல் பதிவேடுகள்"}', true, 4),
  ('tax-accounting', 'itr-filing', 'form16', '{"en":"Form 16 / 26AS","hi":"फॉर्म 16 / 26AS","te":"ఫారం 16 / 26AS","ta":"படிவம் 16 / 26AS"}', false, 5),
  ('legal', NULL, 'id_proof', '{"en":"ID proof of the signatory","hi":"हस्ताक्षरकर्ता का पहचान प्रमाण","te":"సంతకందారు గుర్తింపు రుజువు","ta":"கையொப்பமிடுபவரின் அடையாளச் சான்று"}', true, 1),
  ('legal', NULL, 'existing_documents', '{"en":"Existing agreement or notice","hi":"मौजूदा अनुबंध या नोटिस","te":"ఇప్పటికే ఉన్న ఒప్పందం లేదా నోటీసు","ta":"ஏற்கனவே உள்ள ஒப்பந்தம் அல்லது அறிவிப்பு"}', false, 2),
  ('legal', 'trademark', 'logo_file', '{"en":"Logo / brand name file","hi":"लोगो / ब्रांड नाम फ़ाइल","te":"లోగో / బ్రాండ్ పేరు ఫైల్","ta":"லோகோ / பிராண்ட் பெயர் கோப்பு"}', true, 3),
  ('hr-staffing', NULL, 'job_description', '{"en":"Job description","hi":"नौकरी का विवरण","te":"ఉద్యోగ వివరణ","ta":"வேலை விவரம்"}', true, 1),
  ('hr-staffing', 'payroll', 'employee_list', '{"en":"Employee list with salaries","hi":"वेतन सहित कर्मचारी सूची","te":"జీతాలతో ఉద్యోగుల జాబితా","ta":"சம்பளத்துடன் பணியாளர் பட்டியல்"}', true, 2),
  ('finance-facilitation', NULL, 'pan', '{"en":"Business PAN","hi":"व्यवसाय का PAN","te":"వ్యాపార PAN","ta":"வணிக PAN"}', true, 1),
  ('finance-facilitation', NULL, 'itr_two_years', '{"en":"Income tax returns, last 2 years","hi":"पिछले 2 साल के आयकर रिटर्न","te":"గత 2 సంవత్సరాల ఆదాయపు పన్ను రిటర్న్‌లు","ta":"கடந்த 2 ஆண்டுகளின் வருமான வரி ரிட்டர்ன்கள்"}', true, 2),
  ('finance-facilitation', NULL, 'bank_six_months', '{"en":"Bank statements, last 6 months","hi":"पिछले 6 महीने के बैंक स्टेटमेंट","te":"గత 6 నెలల బ్యాంక్ స్టేట్‌మెంట్లు","ta":"கடந்த 6 மாத வங்கி அறிக்கைகள்"}', true, 3),
  ('finance-facilitation', NULL, 'gst_returns', '{"en":"GST returns","hi":"GST रिटर्न","te":"GST రిటర్న్‌లు","ta":"GST ரிட்டர்ன்கள்"}', false, 4),
  ('digital-marketing', NULL, 'brand_assets', '{"en":"Logo and brand assets","hi":"लोगो और ब्रांड सामग्री","te":"లోగో, బ్రాండ్ మెటీరియల్","ta":"லோகோ மற்றும் பிராண்ட் பொருட்கள்"}', false, 1),
  ('digital-marketing', NULL, 'account_access', '{"en":"Access to your social / ad accounts","hi":"सोशल / विज्ञापन खातों की पहुँच","te":"సోషల్ / యాడ్ ఖాతాల యాక్సెస్","ta":"சமூக / விளம்பரக் கணக்குகளுக்கான அணுகல்"}', false, 2),
  ('web-tech', NULL, 'brand_assets', '{"en":"Logo, photos and text","hi":"लोगो, फ़ोटो और टेक्स्ट","te":"లోగో, ఫోటోలు, టెక్స్ట్","ta":"லோகோ, படங்கள், உரை"}', false, 1),
  ('web-tech', NULL, 'domain_access', '{"en":"Domain / hosting access","hi":"डोमेन / होस्टिंग की पहुँच","te":"డొమైన్ / హోస్టింగ్ యాక్సెస్","ta":"டொமைன் / ஹோஸ்டிங் அணுகல்"}', false, 2),
  ('government-licensing', NULL, 'pan', '{"en":"Business PAN","hi":"व्यवसाय का PAN","te":"వ్యాపార PAN","ta":"வணிக PAN"}', true, 1),
  ('government-licensing', NULL, 'site_address_proof', '{"en":"Site address proof","hi":"स्थल के पते का प्रमाण","te":"స్థల చిరునామా రుజువు","ta":"தள முகவரிச் சான்று"}', true, 2),
  ('government-licensing', NULL, 'site_plan', '{"en":"Site / factory plan","hi":"स्थल / फ़ैक्टरी नक्शा","te":"స్థల / ఫ్యాక్టరీ ప్లాన్","ta":"தள / தொழிற்சாலை வரைபடம்"}', false, 3),
  ('government-licensing', NULL, 'udyam_certificate', '{"en":"Udyam certificate","hi":"उद्यम प्रमाणपत्र","te":"ఉద్యమ్ సర్టిఫికేట్","ta":"உத்யம் சான்றிதழ்"}', false, 4)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS quote_sla_stats (
  category_slug   text NOT NULL,
  state           text NOT NULL,
  median_minutes  integer,
  n               integer NOT NULL DEFAULT 0 CHECK (n >= 0),
  computed_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz,
  PRIMARY KEY (category_slug, state)
);
--> statement-breakpoint
ALTER TABLE quote_sla_stats ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "quote_sla_stats: public read" ON quote_sla_stats;
--> statement-breakpoint
CREATE POLICY "quote_sla_stats: public read" ON quote_sla_stats FOR SELECT USING (true);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON quote_sla_stats FROM anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS quote_sla_stats_set_updated_at ON quote_sla_stats;
--> statement-breakpoint
CREATE TRIGGER quote_sla_stats_set_updated_at BEFORE UPDATE ON quote_sla_stats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- Median minutes from the moment providers were notified (fanout_at, else the
-- create) to the FIRST quote, per category × the buyer's state, over service
-- RFQs created in the last 90 days that received a quote. One transaction:
-- the table is replaced, so a cell that stopped qualifying disappears.
CREATE OR REPLACE FUNCTION refresh_quote_sla_stats() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE written integer;
BEGIN
  -- A WHERE clause: Supabase's safeupdate rejects an unqualified DELETE over PostgREST (the cron calls this by RPC).
  DELETE FROM quote_sla_stats WHERE true;
  INSERT INTO quote_sla_stats (category_slug, state, median_minutes, n, computed_at)
  SELECT c.slug, m.state,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY fq.minutes))::integer,
         count(*)::integer,
         now()
  FROM rfqs r
  JOIN categories c ON c.id = r.category_id
  JOIN msme_profiles m ON m.id = r.msme_id
  JOIN LATERAL (
    SELECT GREATEST(0, EXTRACT(EPOCH FROM (min(q.created_at) - coalesce(r.fanout_at, r.created_at))) / 60.0) AS minutes
    FROM quotes q WHERE q.rfq_id = r.id
    HAVING min(q.created_at) IS NOT NULL
  ) fq ON true
  -- Service RFQs only: goods RFQs have no category_id, so the JOIN drops them
  -- (rfqs.kind is a STAGED Mart column — never named outside Mart code).
  WHERE r.created_at >= now() - interval '90 days'
    AND r.deleted_at IS NULL
    AND m.state IS NOT NULL
  GROUP BY c.slug, m.state;
  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION refresh_quote_sla_stats() FROM PUBLIC, anon, authenticated;
