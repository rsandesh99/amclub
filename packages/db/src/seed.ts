/**
 * Phase 1 seed script.
 * Creates: 8 categories (with rfq_templates), 20 providers, 60 packages, 10 MSMEs.
 * Uses Supabase admin API to create auth users; service-role DB for inserts.
 * Idempotent: deletes existing seed data (identified by seed marker) before re-inserting.
 */

import postgres from 'postgres'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../../../apps/web/.env.local') })
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') })

const SUPABASE_URL = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const DATABASE_URL = process.env['DATABASE_URL']!

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !DATABASE_URL)
  throw new Error('Missing env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL')

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const db = postgres(DATABASE_URL, { max: 1 })

// ─── Category definitions ──────────────────────────────────────────────────────

const CATEGORIES = [
  {
    slug: 'company-registrations',
    nameI18n: { en: 'Company & Registrations', hi: 'कंपनी एवं पंजीकरण' },
    descriptionI18n: {
      en: 'Pvt Ltd / LLP / OPC incorporation, Udyam, GST, FSSAI, IEC',
      hi: 'प्राइवेट लिमिटेड / एलएलपी / ओपीसी निगमन, उद्यम, जीएसटी, एफएसएसएआई',
    },
    icon: 'building-2',
    commissionBps: 1000,
    requiredCredentials: ['icsi', 'ca'],
    sortOrder: 1,
    rfqTemplate: {
      fields: [
        { name: 'entity_type', type: 'select', label_en: 'Entity Type', label_hi: 'इकाई प्रकार', required: true, options: ['Private Limited', 'LLP', 'OPC', 'Sole Proprietorship', 'Partnership', 'GST Registration', 'Udyam Registration', 'FSSAI', 'IEC'] },
        { name: 'state', type: 'text', label_en: 'State of Incorporation', label_hi: 'निगमन का राज्य', required: true },
        { name: 'directors_count', type: 'select', label_en: 'Number of Directors/Partners', label_hi: 'निदेशकों/साझेदारों की संख्या', required: false, options: ['1', '2', '3', '4', '5+'] },
        { name: 'notes', type: 'textarea', label_en: 'Additional Details', label_hi: 'अतिरिक्त विवरण', required: false },
      ],
    },
  },
  {
    slug: 'tax-accounting',
    nameI18n: { en: 'Tax & Accounting', hi: 'कर एवं लेखा' },
    descriptionI18n: {
      en: 'GST filing, ITR, bookkeeping, audits, TDS',
      hi: 'जीएसटी रिटर्न, आईटीआर, बहीखाता, ऑडिट, टीडीएस',
    },
    icon: 'calculator',
    commissionBps: 1000,
    requiredCredentials: ['icai'],
    sortOrder: 2,
    rfqTemplate: {
      fields: [
        { name: 'filing_type', type: 'select', label_en: 'Filing Type', label_hi: 'दाखिल प्रकार', required: true, options: ['GST Return (Monthly)', 'GST Return (Quarterly)', 'ITR Filing', 'TDS Return', 'Bookkeeping', 'Annual Audit', 'Tax Planning'] },
        { name: 'financial_year', type: 'text', label_en: 'Financial Year', label_hi: 'वित्तीय वर्ष', required: true, placeholder_en: 'e.g. 2024-25' },
        { name: 'turnover_range', type: 'select', label_en: 'Annual Turnover', label_hi: 'वार्षिक कारोबार', required: true, options: ['< ₹20 lakh', '₹20 lakh – ₹1 crore', '₹1–5 crore', '₹5–20 crore', '> ₹20 crore'] },
        { name: 'transactions_per_month', type: 'select', label_en: 'Transactions / Month', label_hi: 'प्रति माह लेनदेन', required: false, options: ['< 50', '50–200', '200–500', '500+'] },
        { name: 'notes', type: 'textarea', label_en: 'Additional Details', label_hi: 'अतिरिक्त विवरण', required: false },
      ],
    },
  },
  {
    slug: 'legal',
    nameI18n: { en: 'Legal', hi: 'कानूनी सेवाएं' },
    descriptionI18n: {
      en: 'Contracts, trademarks / IP, notices, labour-law compliance',
      hi: 'अनुबंध, ट्रेडमार्क / आईपी, नोटिस, श्रम कानून अनुपालन',
    },
    icon: 'scale',
    commissionBps: 1200,
    requiredCredentials: ['bar_council'],
    sortOrder: 3,
    rfqTemplate: {
      fields: [
        { name: 'legal_service', type: 'select', label_en: 'Service Required', label_hi: 'आवश्यक सेवा', required: true, options: ['Trademark Registration', 'Contract Drafting', 'Legal Notice', 'Labour Law Compliance', 'IP Protection', 'NDA / MoU', 'Partnership Deed', 'Other'] },
        { name: 'urgency', type: 'select', label_en: 'Urgency', label_hi: 'अत्यावश्यकता', required: true, options: ['Within 3 days', 'Within 1 week', 'Within 2 weeks', 'No rush'] },
        { name: 'languages', type: 'select', label_en: 'Preferred Language', label_hi: 'पसंदीदा भाषा', required: false, options: ['English', 'Hindi', 'Telugu', 'Tamil', 'Marathi'] },
        { name: 'notes', type: 'textarea', label_en: 'Describe Your Legal Need', label_hi: 'अपनी कानूनी आवश्यकता बताएं', required: true },
      ],
    },
  },
  {
    slug: 'hr-staffing',
    nameI18n: { en: 'HR & Staffing', hi: 'एचआर एवं स्टाफिंग' },
    descriptionI18n: {
      en: 'Recruitment (skilled / unskilled), payroll, HR policy setup',
      hi: 'भर्ती (कुशल / अकुशल), वेतन प्रबंधन, एचआर नीति',
    },
    icon: 'users',
    commissionBps: 1000,
    requiredCredentials: [],
    sortOrder: 4,
    rfqTemplate: {
      fields: [
        { name: 'hr_service', type: 'select', label_en: 'Service Type', label_hi: 'सेवा प्रकार', required: true, options: ['Permanent Recruitment', 'Contractual Staffing', 'Payroll Management', 'HR Policy Setup', 'PF / ESIC Compliance', 'Appraisal Process', 'Background Verification'] },
        { name: 'headcount', type: 'select', label_en: 'Headcount Needed', label_hi: 'आवश्यक कर्मचारी संख्या', required: false, options: ['1–5', '6–20', '21–50', '50+', 'N/A (Policy/Payroll)'] },
        { name: 'role_type', type: 'text', label_en: 'Role / Department', label_hi: 'भूमिका / विभाग', required: false },
        { name: 'notes', type: 'textarea', label_en: 'Additional Requirements', label_hi: 'अतिरिक्त आवश्यकताएं', required: false },
      ],
    },
  },
  {
    slug: 'finance-facilitation',
    nameI18n: { en: 'Finance Facilitation', hi: 'वित्त सुविधा' },
    descriptionI18n: {
      en: 'Loan documentation, CGTMSE / Mudra application, project reports',
      hi: 'ऋण दस्तावेज़, सीजीटीएमएसई / मुद्रा आवेदन, प्रोजेक्ट रिपोर्ट',
    },
    icon: 'banknote',
    commissionBps: 800,
    requiredCredentials: [],
    sortOrder: 5,
    rfqTemplate: {
      fields: [
        { name: 'finance_type', type: 'select', label_en: 'Finance Type', label_hi: 'वित्त प्रकार', required: true, options: ['Working Capital Loan', 'Term Loan', 'Mudra Loan', 'CGTMSE Guarantee', 'PMEGP Application', 'Project Report', 'Business Plan', 'Subsidy Application'] },
        { name: 'loan_amount', type: 'select', label_en: 'Loan Amount Required', label_hi: 'आवश्यक ऋण राशि', required: false, options: ['< ₹5 lakh', '₹5–25 lakh', '₹25 lakh – ₹1 crore', '₹1–5 crore', '> ₹5 crore'] },
        { name: 'business_vintage', type: 'select', label_en: 'Business Vintage', label_hi: 'व्यवसाय की आयु', required: true, options: ['< 1 year', '1–3 years', '3–5 years', '5+ years'] },
        { name: 'notes', type: 'textarea', label_en: 'Additional Context', label_hi: 'अतिरिक्त जानकारी', required: false },
      ],
    },
  },
  {
    slug: 'digital-marketing',
    nameI18n: { en: 'Digital Marketing', hi: 'डिजिटल मार्केटिंग' },
    descriptionI18n: {
      en: 'Social media, SEO, performance ads, branding',
      hi: 'सोशल मीडिया, एसईओ, परफॉर्मेंस विज्ञापन, ब्रांडिंग',
    },
    icon: 'trending-up',
    commissionBps: 1200,
    requiredCredentials: [],
    sortOrder: 6,
    rfqTemplate: {
      fields: [
        { name: 'marketing_service', type: 'select', label_en: 'Service Required', label_hi: 'आवश्यक सेवा', required: true, options: ['Social Media Management', 'SEO', 'Google / Meta Ads', 'Logo & Branding', 'Website Content', 'Email Marketing', 'WhatsApp Marketing', 'Video Production'] },
        { name: 'monthly_budget', type: 'select', label_en: 'Monthly Ad Budget', label_hi: 'मासिक विज्ञापन बजट', required: false, options: ['< ₹10,000', '₹10–50K', '₹50K–2L', '> ₹2 lakh', 'No paid ads'] },
        { name: 'industry', type: 'text', label_en: 'Your Industry / Product', label_hi: 'आपका उद्योग / उत्पाद', required: true },
        { name: 'notes', type: 'textarea', label_en: 'Goals & Context', label_hi: 'लक्ष्य एवं संदर्भ', required: false },
      ],
    },
  },
  {
    slug: 'web-tech',
    nameI18n: { en: 'Web & Tech', hi: 'वेब एवं टेक' },
    descriptionI18n: {
      en: 'Websites, e-commerce, ONDC onboarding, app development',
      hi: 'वेबसाइट, ई-कॉमर्स, ओएनडीसी ऑनबोर्डिंग, ऐप विकास',
    },
    icon: 'monitor',
    commissionBps: 1200,
    requiredCredentials: [],
    sortOrder: 7,
    rfqTemplate: {
      fields: [
        { name: 'tech_service', type: 'select', label_en: 'Service Required', label_hi: 'आवश्यक सेवा', required: true, options: ['Business Website', 'E-commerce Store', 'ONDC Onboarding', 'Android App', 'iOS App', 'Inventory Management', 'CRM Setup', 'Tech Support Retainer'] },
        { name: 'budget_range', type: 'select', label_en: 'Budget Range', label_hi: 'बजट सीमा', required: false, options: ['< ₹15,000', '₹15–50K', '₹50K–2L', '₹2–10L', '> ₹10 lakh'] },
        { name: 'timeline', type: 'select', label_en: 'Expected Timeline', label_hi: 'अपेक्षित समय', required: true, options: ['< 2 weeks', '2–4 weeks', '1–3 months', '3+ months'] },
        { name: 'notes', type: 'textarea', label_en: 'Features / Requirements', label_hi: 'फीचर / आवश्यकताएं', required: false },
      ],
    },
  },
  {
    slug: 'government-licensing',
    nameI18n: { en: 'Government & Licensing', hi: 'सरकारी लाइसेंस' },
    descriptionI18n: {
      en: 'Factory licence, pollution NOC, subsidies (PMEGP, state schemes), GeM / tender',
      hi: 'फैक्ट्री लाइसेंस, प्रदूषण एनओसी, सब्सिडी, जीईएम / टेंडर',
    },
    icon: 'landmark',
    commissionBps: 1000,
    requiredCredentials: [],
    sortOrder: 8,
    rfqTemplate: {
      fields: [
        { name: 'license_type', type: 'select', label_en: 'License / Scheme', label_hi: 'लाइसेंस / योजना', required: true, options: ['Factory Licence', 'Pollution Control NOC', 'PMEGP Application', 'State Subsidy Scheme', 'GeM Registration', 'Tender / eProcurement', 'Fire NOC', 'Trade Licence Renewal', 'Other'] },
        { name: 'state', type: 'text', label_en: 'State', label_hi: 'राज्य', required: true },
        { name: 'urgency', type: 'select', label_en: 'Urgency', label_hi: 'अत्यावश्यकता', required: false, options: ['Urgent (< 1 week)', 'Normal (2–4 weeks)', 'Flexible'] },
        { name: 'notes', type: 'textarea', label_en: 'Additional Details', label_hi: 'अतिरिक्त विवरण', required: false },
      ],
    },
  },
]

// ─── Provider definitions (20 providers) ──────────────────────────────────────

const STATES = ['AP', 'TS', 'KA', 'TN', 'MH', 'GJ', 'RJ', 'UP', 'DL', 'WB']
const CITIES: Record<string, string> = {
  AP: 'Vijayawada', TS: 'Hyderabad', KA: 'Bengaluru', TN: 'Chennai',
  MH: 'Pune', GJ: 'Ahmedabad', RJ: 'Jaipur', UP: 'Lucknow', DL: 'Delhi', WB: 'Kolkata',
}

const PROVIDERS = [
  { name: 'Sharma & Associates', slug: 'sharma-associates', category: 'tax-accounting', state: 'MH', creds: ['icai'], status: 'active' },
  { name: 'LegalEdge Advocates', slug: 'legaledge-advocates', category: 'legal', state: 'DL', creds: ['bar_council'], status: 'active' },
  { name: 'StartRight Consultants', slug: 'startright-consultants', category: 'company-registrations', state: 'KA', creds: ['icsi'], status: 'active' },
  { name: 'DigitalBharat Agency', slug: 'digitalbharat-agency', category: 'digital-marketing', state: 'MH', creds: [], status: 'active' },
  { name: 'TechCraft Solutions', slug: 'techcraft-solutions', category: 'web-tech', state: 'TS', creds: [], status: 'active' },
  { name: 'Nidhi Finance DSA', slug: 'nidhi-finance-dsa', category: 'finance-facilitation', state: 'GJ', creds: [], status: 'active' },
  { name: 'PeopleFirst HR', slug: 'peoplefirst-hr', category: 'hr-staffing', state: 'KA', creds: [], status: 'active' },
  { name: 'LicenceWala', slug: 'licencewala', category: 'government-licensing', state: 'UP', creds: [], status: 'active' },
  { name: 'Kapoor Tax Services', slug: 'kapoor-tax-services', category: 'tax-accounting', state: 'DL', creds: ['icai'], status: 'active' },
  { name: 'South Legal Partners', slug: 'south-legal-partners', category: 'legal', state: 'TN', creds: ['bar_council'], status: 'active' },
  { name: 'BizReg Experts', slug: 'bizreg-experts', category: 'company-registrations', state: 'RJ', creds: ['icsi', 'ca'], status: 'active' },
  { name: 'GrowthPulse Digital', slug: 'growthpulse-digital', category: 'digital-marketing', state: 'KA', creds: [], status: 'active' },
  { name: 'WebMint Studios', slug: 'webmint-studios', category: 'web-tech', state: 'AP', creds: [], status: 'active' },
  { name: 'Mudra Loan Advisors', slug: 'mudra-loan-advisors', category: 'finance-facilitation', state: 'MH', creds: [], status: 'active' },
  { name: 'TalentBridge Staffing', slug: 'talentbridge-staffing', category: 'hr-staffing', state: 'TS', creds: [], status: 'active' },
  { name: 'PermitPro Services', slug: 'permitpro-services', category: 'government-licensing', state: 'TN', creds: [], status: 'active' },
  { name: 'Rajesh & Co CA', slug: 'rajesh-co-ca', category: 'tax-accounting', state: 'AP', creds: ['icai'], status: 'active' },
  { name: 'CompanySetup.in', slug: 'companysetup-in', category: 'company-registrations', state: 'MH', creds: ['icsi'], status: 'active' },
  { name: 'BrandBuilders', slug: 'brandbuilders', category: 'digital-marketing', state: 'GJ', creds: [], status: 'active' },
  { name: 'AppForge Dev', slug: 'appforge-dev', category: 'web-tech', state: 'KA', creds: [], status: 'active' },
]

// ─── Package templates per category (3 per provider) ─────────────────────────

function getPackages(categorySlug: string, priceTier: number) {
  const base = priceTier // multiplier 1–3

  const MAP: Record<string, Array<{ title: string; price: number; days: number; discount?: number }>> = {
    'tax-accounting': [
      { title: 'GST Return Filing (Monthly)', price: 199900 * base, days: 5, discount: 0 },
      { title: 'ITR Filing – Business', price: 299900 * base, days: 7, discount: 1000 },
      { title: 'Full Accounting Retainer', price: 999900 * base, days: 30, discount: 1500 },
    ],
    'legal': [
      { title: 'Trademark Registration', price: 499900 * base, days: 14, discount: 0 },
      { title: 'Contract Drafting', price: 299900 * base, days: 5, discount: 500 },
      { title: 'Legal Notice (2 pages)', price: 149900 * base, days: 3, discount: 0 },
    ],
    'company-registrations': [
      { title: 'Private Limited Incorporation', price: 699900 * base, days: 15, discount: 2000 },
      { title: 'GST Registration', price: 199900 * base, days: 7, discount: 0 },
      { title: 'Udyam + MSME Certificate', price: 149900 * base, days: 5, discount: 0 },
    ],
    'digital-marketing': [
      { title: 'Social Media Management (1 month)', price: 499900 * base, days: 30, discount: 1000 },
      { title: 'Google Ads Campaign Setup', price: 699900 * base, days: 10, discount: 0 },
      { title: 'Brand Identity Package', price: 399900 * base, days: 14, discount: 800 },
    ],
    'web-tech': [
      { title: 'Business Website (5 pages)', price: 999900 * base, days: 21, discount: 2000 },
      { title: 'E-commerce Store Setup', price: 1999900 * base, days: 30, discount: 2500 },
      { title: 'ONDC Seller Onboarding', price: 299900 * base, days: 7, discount: 0 },
    ],
    'finance-facilitation': [
      { title: 'Mudra Loan Application', price: 299900 * base, days: 14, discount: 0 },
      { title: 'Project Report (Bank Loan)', price: 499900 * base, days: 10, discount: 1000 },
      { title: 'CGTMSE Guarantee Application', price: 399900 * base, days: 14, discount: 500 },
    ],
    'hr-staffing': [
      { title: 'HR Policy Manual', price: 399900 * base, days: 14, discount: 0 },
      { title: 'Payroll Setup & Management', price: 699900 * base, days: 7, discount: 800 },
      { title: 'PF/ESIC Registration & Compliance', price: 299900 * base, days: 10, discount: 0 },
    ],
    'government-licensing': [
      { title: 'Factory Licence Application', price: 599900 * base, days: 21, discount: 0 },
      { title: 'GeM Portal Registration', price: 249900 * base, days: 10, discount: 500 },
      { title: 'Pollution NOC (Consent to Operate)', price: 449900 * base, days: 30, discount: 0 },
    ],
  }

  return MAP[categorySlug] ?? MAP['tax-accounting']
}

// ─── MSME definitions ─────────────────────────────────────────────────────────

const MSMES = [
  { business: 'Ramesh Fabricators', state: 'AP', sector: 'manufacturing', employees: '10-49' },
  { business: 'Priya Saree House', state: 'WB', sector: 'trade', employees: '1-9' },
  { business: 'Kumar Auto Spares', state: 'TN', sector: 'trade', employees: '10-49' },
  { business: 'Vijay Food Products', state: 'MH', sector: 'manufacturing', employees: '10-49' },
  { business: 'Sunita Boutique', state: 'RJ', sector: 'services', employees: '1-9' },
  { business: 'Arjun Logistics', state: 'GJ', sector: 'services', employees: '10-49' },
  { business: 'Meena Exports', state: 'KA', sector: 'trade', employees: '10-49' },
  { business: 'Ravi Construction', state: 'TS', sector: 'manufacturing', employees: '50-249' },
  { business: 'Lakshmi Textiles', state: 'TN', sector: 'manufacturing', employees: '10-49' },
  { business: 'Gopal Software Solutions', state: 'DL', sector: 'services', employees: '1-9' },
]

// ─── Main ─────────────────────────────────────────────────────────────────────

async function createAuthUser(phone: string, name: string) {
  const { data, error } = await adminClient.auth.admin.createUser({
    phone,
    phone_confirm: true,
    user_metadata: { full_name: name },
  })
  if (error) throw new Error(`Failed to create auth user ${phone}: ${error.message}`)
  return data.user.id
}

async function main() {
  console.log('🌱 Starting Phase 1 seed...\n')

  // ── 1. Insert categories ─────────────────────────────────────────────────────
  console.log('1/4 Inserting categories...')
  const categoryIds: Record<string, string> = {}

  for (const cat of CATEGORIES) {
    const [row] = await db`
      INSERT INTO categories (slug, name_i18n, description_i18n, icon, commission_bps, required_credentials, rfq_template, sort_order, is_active)
      VALUES (
        ${cat.slug},
        ${db.json(cat.nameI18n)},
        ${db.json(cat.descriptionI18n)},
        ${cat.icon},
        ${cat.commissionBps},
        ${cat.requiredCredentials},
        ${db.json(cat.rfqTemplate)},
        ${cat.sortOrder},
        true
      )
      ON CONFLICT (slug) DO UPDATE SET
        name_i18n = EXCLUDED.name_i18n,
        description_i18n = EXCLUDED.description_i18n,
        rfq_template = EXCLUDED.rfq_template,
        commission_bps = EXCLUDED.commission_bps,
        sort_order = EXCLUDED.sort_order
      RETURNING id
    `
    categoryIds[cat.slug] = row.id
  }
  console.log(`  ✓ ${CATEGORIES.length} categories upserted`)

  // ── 2. Create providers ──────────────────────────────────────────────────────
  console.log('\n2/4 Creating providers...')
  const providerProfileIds: string[] = []

  for (let i = 0; i < PROVIDERS.length; i++) {
    const p = PROVIDERS[i]!
    const phone = `+9198000${String(i + 1).padStart(5, '0')}`

    let userId: string
    // Check if user already exists (idempotency)
    const existing = await db`SELECT id FROM users WHERE phone = ${phone} LIMIT 1`
    if (existing.length > 0) {
      userId = existing[0].id
    } else {
      userId = await createAuthUser(phone, p.name)
      await db`
        INSERT INTO users (id, phone, full_name, roles)
        VALUES (${userId}, ${phone}, ${p.name}, ${'{"provider"}'}::text[])
        ON CONFLICT (id) DO NOTHING
      `
    }

    const catId = categoryIds[p.category]!
    const state = p.state
    const city = CITIES[state] ?? 'Mumbai'
    const avgRating = (3.8 + Math.random() * 1.2).toFixed(1)
    const reviewCount = Math.floor(10 + Math.random() * 90)

    const [pp] = await db`
      INSERT INTO provider_profiles (user_id, legal_name, display_name, slug, state, city, languages, status, avg_rating, review_count, completed_orders)
      VALUES (
        ${userId}, ${p.name}, ${p.name}, ${p.slug}, ${state}, ${city},
        ${'{"en","hi"}'}::text[],
        ${p.status},
        ${avgRating}::text,
        ${reviewCount},
        ${Math.floor(reviewCount * 0.8)}
      )
      ON CONFLICT (slug) DO UPDATE SET status = EXCLUDED.status, avg_rating = EXCLUDED.avg_rating
      RETURNING id
    `
    const ppId = pp.id
    providerProfileIds.push(ppId)

    // provider_categories
    await db`
      INSERT INTO provider_categories (provider_id, category_id)
      VALUES (${ppId}, ${catId})
      ON CONFLICT DO NOTHING
    `

    // provider_verifications (mark as verified for seed providers)
    for (const cred of p.creds) {
      await db`
        INSERT INTO provider_verifications (provider_id, kind, value, status)
        VALUES (${ppId}, ${cred}, ${'SEED-' + cred.toUpperCase() + '-' + i}, 'manually_approved')
        ON CONFLICT DO NOTHING
      `
    }
  }
  console.log(`  ✓ ${PROVIDERS.length} providers created`)

  // ── 3. Create packages (3 per provider = 60 total) ──────────────────────────
  console.log('\n3/4 Creating packages...')
  let pkgCount = 0

  for (let i = 0; i < PROVIDERS.length; i++) {
    const p = PROVIDERS[i]!
    const ppId = providerProfileIds[i]!
    const catId = categoryIds[p.category]!
    const pkgs = getPackages(p.category, (i % 3) + 1)

    for (const pkg of pkgs) {
      const slug = `${p.slug}-pkg-${pkgs.indexOf(pkg) + 1}`
      await db`
        INSERT INTO packages (provider_id, category_id, slug, title_i18n, scope_included, deliverables, requirements_template, price_paise, discount_bps, delivery_days, revision_count, status)
        VALUES (
          ${ppId},
          ${catId},
          ${slug},
          ${db.json({ en: pkg.title, hi: pkg.title })},
          ${db.json(['Primary deliverable included', 'Expert review', 'Digital documents'])},
          ${db.json(['Final document / output', 'Summary report', 'Email support for 30 days'])},
          ${db.json({ fields: [{ name: 'details', type: 'textarea', label_en: 'Describe your requirement', required: true }] })},
          ${pkg.price},
          ${pkg.discount ?? 0},
          ${pkg.days},
          1,
          'active'
        )
        ON CONFLICT (provider_id, slug) DO NOTHING
      `
      pkgCount++
    }
  }
  console.log(`  ✓ ${pkgCount} packages created`)

  // ── 4. Create MSMEs ──────────────────────────────────────────────────────────
  console.log('\n4/4 Creating MSMEs...')

  for (let i = 0; i < MSMES.length; i++) {
    const m = MSMES[i]!
    const phone = `+9197000${String(i + 1).padStart(5, '0')}`

    let userId: string
    const existing = await db`SELECT id FROM users WHERE phone = ${phone} LIMIT 1`
    if (existing.length > 0) {
      userId = existing[0].id
    } else {
      userId = await createAuthUser(phone, m.business)
      await db`
        INSERT INTO users (id, phone, full_name, roles)
        VALUES (${userId}, ${phone}, ${m.business}, ${'{"msme"}'}::text[])
        ON CONFLICT (id) DO NOTHING
      `
    }

    await db`
      INSERT INTO msme_profiles (user_id, business_name, sector, state, city, employee_band, membership_tier, profile_completeness)
      VALUES (
        ${userId}, ${m.business}, ${m.sector}, ${m.state},
        ${CITIES[m.state] ?? 'Mumbai'},
        ${m.employees},
        'free',
        75
      )
      ON CONFLICT (user_id) DO NOTHING
    `
  }
  console.log(`  ✓ ${MSMES.length} MSMEs created`)

  // ── Summary ──────────────────────────────────────────────────────────────────
  const [catCount] = await db`SELECT count(*)::int AS n FROM categories`
  const [pkgTotal] = await db`SELECT count(*)::int AS n FROM packages`
  const [provTotal] = await db`SELECT count(*)::int AS n FROM provider_profiles`
  const [msmeTotal] = await db`SELECT count(*)::int AS n FROM msme_profiles`

  console.log('\n✅ Seed complete:')
  console.log(`   categories     = ${catCount?.n}`)
  console.log(`   packages       = ${pkgTotal?.n}`)
  console.log(`   providers      = ${provTotal?.n}`)
  console.log(`   msme_profiles  = ${msmeTotal?.n}`)

  await db.end()
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
