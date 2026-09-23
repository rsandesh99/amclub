-- E14 FR-14.2 — category names and descriptions in te / ta (the names match the
-- live gateway copy; descriptions are machine drafts on the native-review list in
-- docs/i18n/REVIEW.md). Merges two keys into each i18n map; en / hi untouched.
-- Idempotent. Rollback: UPDATE categories SET name_i18n = name_i18n - 'te' - 'ta',
-- description_i18n = description_i18n - 'te' - 'ta' WHERE slug IN (…the eight slugs…).

UPDATE categories SET
  name_i18n = name_i18n || jsonb_build_object('te', 'కంపెనీ & రిజిస్ట్రేషన్లు', 'ta', 'நிறுவனம் & பதிவுகள்'),
  description_i18n = COALESCE(description_i18n, '{}'::jsonb) || jsonb_build_object('te', 'Pvt Ltd / LLP / OPC ఏర్పాటు, Udyam, GST, FSSAI, IEC', 'ta', 'Pvt Ltd / LLP / OPC நிறுவுதல், Udyam, GST, FSSAI, IEC'),
  updated_at = now()
WHERE slug = 'company-registrations';
--> statement-breakpoint
UPDATE categories SET
  name_i18n = name_i18n || jsonb_build_object('te', 'పన్ను & అకౌంటింగ్', 'ta', 'வரி & கணக்கியல்'),
  description_i18n = COALESCE(description_i18n, '{}'::jsonb) || jsonb_build_object('te', 'GST ఫైలింగ్, ITR, బుక్‌కీపింగ్, ఆడిట్‌లు, TDS', 'ta', 'GST தாக்கல், ITR, கணக்குப் பதிவு, தணிக்கை, TDS'),
  updated_at = now()
WHERE slug = 'tax-accounting';
--> statement-breakpoint
UPDATE categories SET
  name_i18n = name_i18n || jsonb_build_object('te', 'చట్ట సేవలు', 'ta', 'சட்டச் சேவைகள்'),
  description_i18n = COALESCE(description_i18n, '{}'::jsonb) || jsonb_build_object('te', 'ఒప్పందాలు, ట్రేడ్‌మార్క్‌లు / IP, నోటీసులు, కార్మిక చట్టాల పాటింపు', 'ta', 'ஒப்பந்தங்கள், வர்த்தக முத்திரைகள் / IP, நோட்டீஸ்கள், தொழிலாளர் சட்ட இணக்கம்'),
  updated_at = now()
WHERE slug = 'legal';
--> statement-breakpoint
UPDATE categories SET
  name_i18n = name_i18n || jsonb_build_object('te', 'HR & స్టాఫింగ్', 'ta', 'HR & பணியாளர்'),
  description_i18n = COALESCE(description_i18n, '{}'::jsonb) || jsonb_build_object('te', 'రిక్రూట్‌మెంట్ (నైపుణ్యం ఉన్న / లేని), పేరోల్, HR పాలసీ ఏర్పాటు', 'ta', 'ஆட்சேர்ப்பு (திறன் பெற்ற / திறன் பெறாத), சம்பளப் பட்டியல், HR கொள்கை அமைப்பு'),
  updated_at = now()
WHERE slug = 'hr-staffing';
--> statement-breakpoint
UPDATE categories SET
  name_i18n = name_i18n || jsonb_build_object('te', 'ఫైనాన్స్ సదుపాయం', 'ta', 'நிதி வசதி'),
  description_i18n = COALESCE(description_i18n, '{}'::jsonb) || jsonb_build_object('te', 'లోన్ డాక్యుమెంటేషన్, CGTMSE / Mudra దరఖాస్తు, ప్రాజెక్ట్ రిపోర్టులు', 'ta', 'கடன் ஆவணங்கள், CGTMSE / Mudra விண்ணப்பம், திட்ட அறிக்கைகள்'),
  updated_at = now()
WHERE slug = 'finance-facilitation';
--> statement-breakpoint
UPDATE categories SET
  name_i18n = name_i18n || jsonb_build_object('te', 'డిజిటల్ మార్కెటింగ్', 'ta', 'டிஜிட்டல் மார்க்கெட்டிங்'),
  description_i18n = COALESCE(description_i18n, '{}'::jsonb) || jsonb_build_object('te', 'సోషల్ మీడియా, SEO, పెర్ఫార్మెన్స్ యాడ్స్, బ్రాండింగ్', 'ta', 'சமூக ஊடகம், SEO, செயல்திறன் விளம்பரங்கள், பிராண்டிங்'),
  updated_at = now()
WHERE slug = 'digital-marketing';
--> statement-breakpoint
UPDATE categories SET
  name_i18n = name_i18n || jsonb_build_object('te', 'వెబ్ & టెక్', 'ta', 'வெப் & டெக்'),
  description_i18n = COALESCE(description_i18n, '{}'::jsonb) || jsonb_build_object('te', 'వెబ్‌సైట్లు, ఇ-కామర్స్, ONDC ఆన్‌బోర్డింగ్, యాప్ డెవలప్‌మెంట్', 'ta', 'இணையதளங்கள், இ-காமர்ஸ், ONDC இணைப்பு, ஆப் உருவாக்கம்'),
  updated_at = now()
WHERE slug = 'web-tech';
--> statement-breakpoint
UPDATE categories SET
  name_i18n = name_i18n || jsonb_build_object('te', 'ప్రభుత్వ & లైసెన్సింగ్', 'ta', 'அரசு & உரிமம்'),
  description_i18n = COALESCE(description_i18n, '{}'::jsonb) || jsonb_build_object('te', 'ఫ్యాక్టరీ లైసెన్స్, పొల్యూషన్ NOC, సబ్సిడీలు (PMEGP, రాష్ట్ర పథకాలు), GeM / టెండర్', 'ta', 'தொழிற்சாலை உரிமம், மாசு NOC, மானியங்கள் (PMEGP, மாநிலத் திட்டங்கள்), GeM / டெண்டர்'),
  updated_at = now()
WHERE slug = 'government-licensing';
