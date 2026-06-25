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
  name_i18n: { en: string; hi: string }
  description_i18n: { en: string; hi: string }
  icon: string
}

export const CATEGORIES: Record<CategorySlug, CategoryMeta> = {
  'company-registrations': {
    slug: 'company-registrations',
    commission_bps: 1000,
    required_credentials: ['gstin'],
    icon: 'building-2',
    name_i18n: {
      en: 'Company & Registrations',
      hi: 'कंपनी एवं पंजीकरण',
    },
    description_i18n: {
      en: 'Pvt Ltd / LLP / OPC incorporation, Udyam, GST registration, FSSAI, IEC, MSME certificates',
      hi: 'प्राइवेट लिमिटेड / एलएलपी / ओपीसी निगमन, उद्यम, जीएसटी पंजीकरण, एफएसएसएआई, आईईसी',
    },
  },
  'tax-accounting': {
    slug: 'tax-accounting',
    commission_bps: 1000,
    required_credentials: ['icai'],
    icon: 'calculator',
    name_i18n: {
      en: 'Tax & Accounting',
      hi: 'कर एवं लेखा',
    },
    description_i18n: {
      en: 'GST filing, ITR, bookkeeping, audits, TDS',
      hi: 'जीएसटी दाखिल, आईटीआर, बहीखाता, ऑडिट, टीडीएस',
    },
  },
  legal: {
    slug: 'legal',
    commission_bps: 1200,
    required_credentials: ['bar_council'],
    icon: 'scale',
    name_i18n: {
      en: 'Legal',
      hi: 'कानूनी सेवाएं',
    },
    description_i18n: {
      en: 'Contracts, trademarks / IP, notices, labour-law compliance',
      hi: 'अनुबंध, ट्रेडमार्क / आईपी, नोटिस, श्रम कानून अनुपालन',
    },
  },
  'hr-staffing': {
    slug: 'hr-staffing',
    commission_bps: 1000,
    required_credentials: [],
    icon: 'users',
    name_i18n: {
      en: 'HR & Staffing',
      hi: 'एचआर एवं स्टाफिंग',
    },
    description_i18n: {
      en: 'Recruitment (skilled / unskilled), payroll, HR policy setup',
      hi: 'भर्ती (कुशल / अकुशल), पेरोल, एचआर नीति सेटअप',
    },
  },
  'finance-facilitation': {
    slug: 'finance-facilitation',
    commission_bps: 800,
    required_credentials: [],
    icon: 'landmark',
    name_i18n: {
      en: 'Finance Facilitation',
      hi: 'वित्त सुविधा',
    },
    description_i18n: {
      en: 'Loan documentation & DSA services, CGTMSE / Mudra application help, project reports',
      hi: 'ऋण दस्तावेज़ीकरण और डीएसए सेवाएं, सीजीटीएमएसई / मुद्रा आवेदन सहायता',
    },
  },
  'digital-marketing': {
    slug: 'digital-marketing',
    commission_bps: 1000,
    required_credentials: [],
    icon: 'megaphone',
    name_i18n: {
      en: 'Digital Marketing',
      hi: 'डिजिटल मार्केटिंग',
    },
    description_i18n: {
      en: 'Social media, SEO, performance ads, branding',
      hi: 'सोशल मीडिया, एसईओ, परफॉर्मेंस विज्ञापन, ब्रांडिंग',
    },
  },
  'web-tech': {
    slug: 'web-tech',
    commission_bps: 1000,
    required_credentials: [],
    icon: 'code-2',
    name_i18n: {
      en: 'Web & Tech',
      hi: 'वेब एवं टेक',
    },
    description_i18n: {
      en: 'Websites, e-commerce setup, ONDC onboarding, app development',
      hi: 'वेबसाइट, ई-कॉमर्स सेटअप, ओएनडीसी ऑनबोर्डिंग, ऐप विकास',
    },
  },
  'government-licensing': {
    slug: 'government-licensing',
    commission_bps: 1000,
    required_credentials: [],
    icon: 'file-badge',
    name_i18n: {
      en: 'Government & Licensing',
      hi: 'सरकारी लाइसेंस एवं अनुमति',
    },
    description_i18n: {
      en: 'Factory licence, pollution NOC, subsidy / scheme applications (PMEGP, state schemes), GeM / tender onboarding',
      hi: 'फैक्ट्री लाइसेंस, प्रदूषण एनओसी, सब्सिडी / योजना आवेदन (पीएमईजीपी), जेम / टेंडर ऑनबोर्डिंग',
    },
  },
}

export const CATEGORY_LIST: CategoryMeta[] = Object.values(CATEGORIES)
