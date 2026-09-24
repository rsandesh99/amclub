/**
 * Canonical 8-category taxonomy for AMClub V1. §1.10.
 * commission_bps: basis points (1000 = 10%). Configurable per-category in DB;
 * these are the launch defaults used for seeding and display.
 */

export const CATEGORY_SLUGS = [
  'company-registrations',
  'tax-accounting',
  'legal',
  'hr-staffing',
  'finance-facilitation',
  'digital-marketing',
  'web-tech',
  'government-licensing',
] as const

export type CategorySlug = (typeof CATEGORY_SLUGS)[number]

export interface CategoryMeta {
  slug: CategorySlug
  /** Default commission in basis points (e.g. 1000 = 10%) */
  commission_bps: number
  /** Credential kinds required from a provider to list in this category */
  required_credentials: string[]
  /** E14 FR-14.2 — all four languages (te / ta names match the gateway copy). */
  name_i18n: { en: string; hi: string; te: string; ta: string }
  description_i18n: { en: string; hi: string; te: string; ta: string }
  icon: string
}

export const CATEGORIES: Record<CategorySlug, CategoryMeta> = {
  'company-registrations': {
    slug: 'company-registrations',
    commission_bps: 500,
    required_credentials: ['gstin'],
    icon: 'building-2',
    name_i18n: {
      en: 'Company & Registrations',
      hi: 'कंपनी एवं पंजीकरण',
      te: 'కంపెనీ & రిజిస్ట్రేషన్లు',
      ta: 'நிறுவனம் & பதிவுகள்',
    },
    description_i18n: {
      en: 'Pvt Ltd / LLP / OPC incorporation, Udyam, GST registration, FSSAI, IEC, MSME certificates',
      hi: 'प्राइवेट लिमिटेड / एलएलपी / ओपीसी निगमन, उद्यम, जीएसटी पंजीकरण, एफएसएसएआई, आईईसी',
      te: 'Pvt Ltd / LLP / OPC ఏర్పాటు, Udyam, GST రిజిస్ట్రేషన్, FSSAI, IEC, MSME సర్టిఫికెట్లు',
      ta: 'Pvt Ltd / LLP / OPC நிறுவுதல், Udyam, GST பதிவு, FSSAI, IEC, MSME சான்றிதழ்கள்',
    },
  },
  'tax-accounting': {
    slug: 'tax-accounting',
    commission_bps: 500,
    required_credentials: ['icai'],
    icon: 'calculator',
    name_i18n: {
      en: 'Tax & Accounting',
      hi: 'कर एवं लेखा',
      te: 'పన్ను & అకౌంటింగ్',
      ta: 'வரி & கணக்கியல்',
    },
    description_i18n: {
      en: 'GST filing, ITR, bookkeeping, audits, TDS',
      hi: 'जीएसटी दाखिल, आईटीआर, बहीखाता, ऑडिट, टीडीएस',
      te: 'GST ఫైలింగ్, ITR, బుక్‌కీపింగ్, ఆడిట్‌లు, TDS',
      ta: 'GST தாக்கல், ITR, கணக்குப் பதிவு, தணிக்கை, TDS',
    },
  },
  legal: {
    slug: 'legal',
    commission_bps: 500,
    required_credentials: ['bar_council'],
    icon: 'scale',
    name_i18n: {
      en: 'Legal',
      hi: 'कानूनी सेवाएं',
      te: 'చట్ట సేవలు',
      ta: 'சட்டச் சேவைகள்',
    },
    description_i18n: {
      en: 'Contracts, trademarks / IP, notices, labour-law compliance',
      hi: 'अनुबंध, ट्रेडमार्क / आईपी, नोटिस, श्रम कानून अनुपालन',
      te: 'ఒప్పందాలు, ట్రేడ్‌మార్క్‌లు / IP, నోటీసులు, కార్మిక చట్టాల పాటింపు',
      ta: 'ஒப்பந்தங்கள், வர்த்தக முத்திரைகள் / IP, நோட்டீஸ்கள், தொழிலாளர் சட்ட இணக்கம்',
    },
  },
  'hr-staffing': {
    slug: 'hr-staffing',
    commission_bps: 500,
    required_credentials: [],
    icon: 'users',
    name_i18n: {
      en: 'HR & Staffing',
      hi: 'एचआर एवं स्टाफिंग',
      te: 'HR & స్టాఫింగ్',
      ta: 'HR & பணியாளர்',
    },
    description_i18n: {
      en: 'Recruitment (skilled / unskilled), payroll, HR policy setup',
      hi: 'भर्ती (कुशल / अकुशल), पेरोल, एचआर नीति सेटअप',
      te: 'రిక్రూట్‌మెంట్ (నైపుణ్యం ఉన్న / లేని), పేరోల్, HR పాలసీ ఏర్పాటు',
      ta: 'ஆட்சேர்ப்பு (திறன் பெற்ற / திறன் பெறாத), சம்பளப் பட்டியல், HR கொள்கை அமைப்பு',
    },
  },
  'finance-facilitation': {
    slug: 'finance-facilitation',
    commission_bps: 500,
    required_credentials: [],
    icon: 'landmark',
    name_i18n: {
      en: 'Finance Facilitation',
      hi: 'वित्त सुविधा',
      te: 'ఫైనాన్స్ సదుపాయం',
      ta: 'நிதி வசதி',
    },
    description_i18n: {
      en: 'Loan documentation & DSA services, CGTMSE / Mudra application help, project reports',
      hi: 'ऋण दस्तावेज़ीकरण और डीएसए सेवाएं, सीजीटीएमएसई / मुद्रा आवेदन सहायता',
      te: 'లోన్ డాక్యుమెంటేషన్ & DSA సేవలు, CGTMSE / Mudra దరఖాస్తు సహాయం, ప్రాజెక్ట్ రిపోర్టులు',
      ta: 'கடன் ஆவணங்கள் & DSA சேவைகள், CGTMSE / Mudra விண்ணப்ப உதவி, திட்ட அறிக்கைகள்',
    },
  },
  'digital-marketing': {
    slug: 'digital-marketing',
    commission_bps: 500,
    required_credentials: [],
    icon: 'megaphone',
    name_i18n: {
      en: 'Digital Marketing',
      hi: 'डिजिटल मार्केटिंग',
      te: 'డిజిటల్ మార్కెటింగ్',
      ta: 'டிஜிட்டல் மார்க்கெட்டிங்',
    },
    description_i18n: {
      en: 'Social media, SEO, performance ads, branding',
      hi: 'सोशल मीडिया, एसईओ, परफॉर्मेंस विज्ञापन, ब्रांडिंग',
      te: 'సోషల్ మీడియా, SEO, పెర్ఫార్మెన్స్ యాడ్స్, బ్రాండింగ్',
      ta: 'சமூக ஊடகம், SEO, செயல்திறன் விளம்பரங்கள், பிராண்டிங்',
    },
  },
  'web-tech': {
    slug: 'web-tech',
    commission_bps: 500,
    required_credentials: [],
    icon: 'code-2',
    name_i18n: {
      en: 'Web & Tech',
      hi: 'वेब एवं टेक',
      te: 'వెబ్ & టెక్',
      ta: 'வெப் & டெக்',
    },
    description_i18n: {
      en: 'Websites, e-commerce setup, ONDC onboarding, app development',
      hi: 'वेबसाइट, ई-कॉमर्स सेटअप, ओएनडीसी ऑनबोर्डिंग, ऐप विकास',
      te: 'వెబ్‌సైట్లు, ఇ-కామర్స్ సెటప్, ONDC ఆన్‌బోర్డింగ్, యాప్ డెవలప్‌మెంట్',
      ta: 'இணையதளங்கள், இ-காமர்ஸ் அமைப்பு, ONDC இணைப்பு, ஆப் உருவாக்கம்',
    },
  },
  'government-licensing': {
    slug: 'government-licensing',
    commission_bps: 500,
    required_credentials: [],
    icon: 'file-badge',
    name_i18n: {
      en: 'Government & Licensing',
      hi: 'सरकारी लाइसेंस एवं अनुमति',
      te: 'ప్రభుత్వ & లైసెన్సింగ్',
      ta: 'அரசு & உரிமம்',
    },
    description_i18n: {
      en: 'Factory licence, pollution NOC, subsidy / scheme applications (PMEGP, state schemes), GeM / tender onboarding',
      hi: 'फैक्ट्री लाइसेंस, प्रदूषण एनओसी, सब्सिडी / योजना आवेदन (पीएमईजीपी), जेम / टेंडर ऑनबोर्डिंग',
      te: 'ఫ్యాక్టరీ లైసెన్స్, పొల్యూషన్ NOC, సబ్సిడీ / పథకాల దరఖాస్తులు (PMEGP, రాష్ట్ర పథకాలు), GeM / టెండర్ ఆన్‌బోర్డింగ్',
      ta: 'தொழிற்சாலை உரிமம், மாசு NOC, மானியம் / திட்ட விண்ணப்பங்கள் (PMEGP, மாநிலத் திட்டங்கள்), GeM / டெண்டர் இணைப்பு',
    },
  },
}

export const CATEGORY_LIST: CategoryMeta[] = Object.values(CATEGORIES)

/**
 * Credential kinds a provider uploads a DOCUMENT for (professional bodies).
 * `gstin`/`pan` are API-verified elsewhere, not uploaded — so they don't make a
 * category require a credential upload.
 */
export const UPLOADED_CREDENTIAL_KINDS = ['icai', 'icsi', 'bar_council', 'ca', 'credential'] as const

/** Does listing in this category require the provider to UPLOAD a credential
 *  document? (§3.3 / §5 required_credentials, excluding API-verified gstin/pan.) */
export function categoryRequiresCredentialUpload(slug: CategorySlug): boolean {
  const cat = CATEGORIES[slug]
  if (!cat) return false
  return cat.required_credentials.some((k) =>
    (UPLOADED_CREDENTIAL_KINDS as readonly string[]).includes(k),
  )
}

/** The subset of the given category slugs that require a credential upload. */
export function categoriesNeedingCredentialUpload(slugs: string[]): string[] {
  return slugs.filter((s) => categoryRequiresCredentialUpload(s as CategorySlug))
}
