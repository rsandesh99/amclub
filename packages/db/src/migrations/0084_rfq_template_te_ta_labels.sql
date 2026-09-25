-- 0084 — Telugu and Tamil labels for the requirement form's category fields (QA F4, 2026-09-25).
-- Data only; NOT staged; idempotent. categories.rfq_template.fields carried label_en / label_hi only, so
-- /te and /ta readers saw "Financial Year", "Annual Turnover" … in English. The form reads label_te /
-- label_ta when present (rfqFieldLabel in shared). This adds them per (category slug, field name) and never
-- overwrites a label someone has already set. A field or category not listed here is left unchanged.
-- Machine-drafted copy, like the te / ta message drafts: a native reviewer may edit the rows later.
-- Rollback: UPDATE categories SET rfq_template = jsonb_set(rfq_template, '{fields}', (SELECT jsonb_agg(f - 'label_te' - 'label_ta') FROM jsonb_array_elements(rfq_template->'fields') f)) WHERE rfq_template ? 'fields';

WITH labels(slug, name, te, ta) AS (
  VALUES
    ('company-registrations', 'entity_type', 'సంస్థ రకం', 'நிறுவன வகை'),
    ('company-registrations', 'state', 'సంస్థ నమోదైన రాష్ట్రం', 'நிறுவனம் பதிவு செய்யப்படும் மாநிலம்'),
    ('company-registrations', 'directors_count', 'డైరెక్టర్లు/భాగస్వాముల సంఖ్య', 'இயக்குநர்கள்/பங்குதாரர்களின் எண்ணிக்கை'),
    ('company-registrations', 'notes', 'అదనపు వివరాలు', 'கூடுதல் விவரங்கள்'),
    ('tax-accounting', 'filing_type', 'ఫైలింగ్ రకం', 'தாக்கல் வகை'),
    ('tax-accounting', 'financial_year', 'ఆర్థిక సంవత్సరం', 'நிதியாண்டு'),
    ('tax-accounting', 'turnover_range', 'వార్షిక టర్నోవర్', 'ஆண்டு விற்றுமுதல்'),
    ('tax-accounting', 'transactions_per_month', 'నెలకు లావాదేవీలు', 'மாதத்திற்கு பரிவர்த்தனைகள்'),
    ('tax-accounting', 'notes', 'అదనపు వివరాలు', 'கூடுதல் விவரங்கள்'),
    ('legal', 'legal_service', 'కావలసిన సేవ', 'தேவையான சேவை'),
    ('legal', 'urgency', 'అత్యవసరత', 'அவசரம்'),
    ('legal', 'languages', 'ఇష్టమైన భాష', 'விருப்பமான மொழி'),
    ('legal', 'notes', 'మీ చట్టపరమైన అవసరాన్ని వివరించండి', 'உங்கள் சட்டத் தேவையை விவரிக்கவும்'),
    ('hr-staffing', 'hr_service', 'సేవ రకం', 'சேவை வகை'),
    ('hr-staffing', 'headcount', 'కావలసిన సిబ్బంది సంఖ్య', 'தேவையான பணியாளர் எண்ணிக்கை'),
    ('hr-staffing', 'role_type', 'పాత్ర / విభాగం', 'பணி / துறை'),
    ('hr-staffing', 'notes', 'అదనపు అవసరాలు', 'கூடுதல் தேவைகள்'),
    ('finance-facilitation', 'finance_type', 'ఫైనాన్స్ రకం', 'நிதி வகை'),
    ('finance-facilitation', 'loan_amount', 'కావలసిన రుణ మొత్తం', 'தேவையான கடன் தொகை'),
    ('finance-facilitation', 'business_vintage', 'వ్యాపారం వయస్సు', 'வணிகத்தின் வயது'),
    ('finance-facilitation', 'notes', 'అదనపు సమాచారం', 'கூடுதல் தகவல்'),
    ('digital-marketing', 'marketing_service', 'కావలసిన సేవ', 'தேவையான சேவை'),
    ('digital-marketing', 'monthly_budget', 'నెలవారీ ప్రకటనల బడ్జెట్', 'மாதாந்திர விளம்பர பட்ஜெட்'),
    ('digital-marketing', 'industry', 'మీ పరిశ్రమ / ఉత్పత్తి', 'உங்கள் தொழில் / தயாரிப்பு'),
    ('digital-marketing', 'notes', 'లక్ష్యాలు & నేపథ్యం', 'இலக்குகள் & பின்னணி'),
    ('web-tech', 'tech_service', 'కావలసిన సేవ', 'தேவையான சேவை'),
    ('web-tech', 'budget_range', 'బడ్జెట్ పరిధి', 'பட்ஜெட் வரம்பு'),
    ('web-tech', 'timeline', 'అంచనా సమయం', 'எதிர்பார்க்கும் கால அளவு'),
    ('web-tech', 'notes', 'ఫీచర్లు / అవసరాలు', 'அம்சங்கள் / தேவைகள்'),
    ('government-licensing', 'license_type', 'లైసెన్స్ / పథకం', 'உரிமம் / திட்டம்'),
    ('government-licensing', 'state', 'రాష్ట్రం', 'மாநிலம்'),
    ('government-licensing', 'urgency', 'అత్యవసరత', 'அவசரம்'),
    ('government-licensing', 'notes', 'అదనపు వివరాలు', 'கூடுதல் விவரங்கள்')
),
patched AS (
  SELECT c.id,
         jsonb_agg(
           CASE
             WHEN l.name IS NULL THEN f
             ELSE f
               || CASE WHEN f ? 'label_te' THEN '{}'::jsonb ELSE jsonb_build_object('label_te', l.te) END
               || CASE WHEN f ? 'label_ta' THEN '{}'::jsonb ELSE jsonb_build_object('label_ta', l.ta) END
           END
           ORDER BY ord
         ) AS fields
  FROM categories c
  CROSS JOIN LATERAL jsonb_array_elements(c.rfq_template->'fields') WITH ORDINALITY AS e(f, ord)
  LEFT JOIN labels l ON l.slug = c.slug AND l.name = f->>'name'
  WHERE jsonb_typeof(c.rfq_template->'fields') = 'array'
  GROUP BY c.id
)
UPDATE categories c
   SET rfq_template = jsonb_set(c.rfq_template, '{fields}', p.fields)
  FROM patched p
 WHERE p.id = c.id
   AND c.rfq_template->'fields' IS DISTINCT FROM p.fields;
