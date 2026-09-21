import { z } from 'zod'
import { INDIAN_STATES } from './states'
import { redactContactInfo, rfqFieldLabel, type RfqTemplate, type RfqTemplateField } from './rfq'

/**
 * RFQ Quality (BUILD_PROMPTS S1.5) — pre-fan-out completeness.
 *
 * Deterministic gaps and risks are CODE (this file, tested); the model only
 * judges whether the free text is specific enough and writes up to three
 * questions in the buyer's locale. `mergeQualityReport` enforces the UNION
 * rule server-side: every rule gap is in the final list (rule items first),
 * the model can only add, never remove, and the cap is three. A deferred RFQ
 * is `status='open'` with `fanout_at IS NULL` — never a status.
 */

export const RFQ_QUALITY_GAPS = ['quantity', 'location', 'timeline', 'budget', 'specs'] as const // generic gaps a template may not name
export type RfqQualityGap = (typeof RFQ_QUALITY_GAPS)[number]
export const RFQ_QUALITY_RISKS = ['contact_info_in_text', 'title_too_vague', 'description_too_short', 'budget_below_floor', 'duplicate_recent'] as const
export type RfqQualityRisk = (typeof RFQ_QUALITY_RISKS)[number]
export const RFQ_QUALITY_LOCALES = ['en', 'hi', 'ta', 'te'] as const
export type RfqQualityLocale = (typeof RFQ_QUALITY_LOCALES)[number]
export const RFQ_QUALITY_DECISIONS = ['answered', 'sent_as_is', 'auto_released', 'skipped'] as const
export type RfqQualityDecision = (typeof RFQ_QUALITY_DECISIONS)[number]
export const RFQ_QUALITY_MAX_MISSING = 3
export const RFQ_QUALITY_SPECS_MIN_CHARS = 80
export const RFQ_QUALITY_DESCRIPTION_MIN_CHARS = 40

export const rfqQualityMissingSchema = z.object({
  /** A template field name OR one of RFQ_QUALITY_GAPS. */
  field: z.string().min(1).max(60),
  /** In the buyer's locale. */
  question: z.string().min(5).max(160),
  why: z.string().max(120).optional(),
  source: z.enum(['rule', 'model']),
})
export type RfqQualityMissing = z.infer<typeof rfqQualityMissingSchema>

export const rfqQualityReportSchema = z
  .object({
    complete: z.boolean(),
    missing: z.array(rfqQualityMissingSchema).max(RFQ_QUALITY_MAX_MISSING),
    risk_flags: z.array(z.enum(RFQ_QUALITY_RISKS)).max(5),
    locale: z.enum(RFQ_QUALITY_LOCALES),
  })
  .strict()
export type RfqQualityReport = z.infer<typeof rfqQualityReportSchema>

/** What the MODEL returns; the server merges it into the report (union rule). */
export const rfqQualityModelOutputSchema = z
  .object({
    specific_enough: z.boolean(),
    gaps: z.array(z.object({ field: z.string().max(60), question: z.string().min(5).max(160), why: z.string().max(120).optional() })).max(RFQ_QUALITY_MAX_MISSING),
  })
  .strict()
export type RfqQualityModelOutput = z.infer<typeof rfqQualityModelOutputSchema>

export const rfqQualityAnswerSchema = z.object({
  answers: z
    .record(z.string().min(1).max(60), z.string().trim().min(1).max(1000))
    .refine((o) => Object.keys(o).length >= 1 && Object.keys(o).length <= RFQ_QUALITY_MAX_MISSING, { message: `1..${RFQ_QUALITY_MAX_MISSING} answers` }),
})
export type RfqQualityAnswerInput = z.infer<typeof rfqQualityAnswerSchema>

export const rfqQualityDecisionSchema = z.enum(RFQ_QUALITY_DECISIONS)

// ── Deterministic precheck ───────────────────────────────────────────────────

export interface RfqQualityPrecheckInput {
  categorySlug: string
  template: RfqTemplate | null
  title: string
  details: Record<string, unknown>
  budgetMinPaise: number | null
  budgetMaxPaise: number | null
  neededBy: string | null
  /** Same buyer, same category, open|quoted, created in the last 24 h, other id — computed by the caller. */
  recentOpenSameCategory: boolean
}

export interface RfqQualityPrecheckResult {
  /** Template fields marked required whose value is empty/whitespace. */
  missingRequired: string[]
  gaps: RfqQualityGap[]
  risks: RfqQualityRisk[]
  /** Rules that could not run on this tree (e.g. no category budget floor). */
  notes: string[]
}

const QTY_FIELD_RE = /qty|quantity|count|units|pages|pieces/i
const LOCATION_FIELD_RE = /state|city|location|site|address|pincode|district/i
const TIMELINE_FIELD_RE = /urgency|timeline|deadline|needed_by|when/i
const BUDGET_FIELD_RE = /budget|loan_amount|amount/i
const TIMELINE_TEXT_RE = /\b(?:\d+\s*)?(?:days?|weeks?|months?|by |before|urgent|asap|immediately|tomorrow|today|jaldi|turant)\b/i
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'for', 'of', 'my', 'our', 'to', 'and', 'in', 'on', 'is', 'are', 'need', 'needed', 'needs', 'want', 'wanted', 'require', 'required', 'requirement',
  'please', 'help', 'me', 'us', 'i', 'we', 'some', 'any', 'get', 'do', 'looking', 'service', 'services',
  'chahiye', 'karna', 'karwana', 'karvana', 'hai', 'hain', 'ke', 'ki', 'ka', 'liye', 'ho', 'kuch', 'mujhe', 'hume', 'mere', 'hamare', 'ek',
])
const CITY_TOKENS = ['mumbai', 'delhi', 'bengaluru', 'bangalore', 'hyderabad', 'chennai', 'kolkata', 'pune', 'ahmedabad', 'surat', 'jaipur', 'lucknow', 'kanpur', 'nagpur', 'indore', 'thane', 'bhopal', 'visakhapatnam', 'vizag', 'vijayawada', 'patna', 'vadodara', 'ghaziabad', 'ludhiana', 'agra', 'nashik', 'faridabad', 'meerut', 'rajkot', 'varanasi', 'srinagar', 'aurangabad', 'dhanbad', 'amritsar', 'noida', 'gurgaon', 'gurugram', 'coimbatore', 'madurai', 'kochi', 'kozhikode', 'trivandrum', 'thiruvananthapuram', 'guntur', 'nellore', 'tirupati', 'warangal', 'mysuru', 'mysore', 'mangaluru', 'hubli', 'salem', 'trichy', 'tiruchirappalli', 'raipur', 'ranchi', 'bhubaneswar', 'guwahati', 'chandigarh', 'dehradun', 'jodhpur', 'udaipur', 'kota']
const STATE_TOKENS = INDIAN_STATES.map((s) => s.label.toLowerCase())

function stringValues(details: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(details ?? {})) if (typeof v === 'string') out[k] = v
  return out
}
const filled = (v: string | undefined): boolean => typeof v === 'string' && v.trim().length > 0

/** True when a filled template field matches the name regex. */
function filledFieldMatching(fields: RfqTemplateField[], strs: Record<string, string>, re: RegExp): boolean {
  return fields.some((f) => re.test(f.name) && filled(strs[f.name]))
}
function hasFieldMatching(fields: RfqTemplateField[], re: RegExp): boolean {
  return fields.some((f) => re.test(f.name))
}

/** Words left in the title after stop-words (Latin + Devanagari/other scripts count as words). */
export function titleContentWords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))
}

/** A state name/code or a major city appears in the text. */
export function mentionsIndianPlace(text: string): boolean {
  const lower = ` ${text.toLowerCase()} `
  if (STATE_TOKENS.some((s) => lower.includes(s))) return true
  if (CITY_TOKENS.some((c) => new RegExp(`\\b${c}\\b`).test(lower))) return true
  // 2-letter state codes only as standalone upper-case tokens (KA, TN, …).
  return INDIAN_STATES.some((s) => new RegExp(`\\b${s.value}\\b`).test(text))
}

export function rfqQualityPrecheck(input: RfqQualityPrecheckInput): RfqQualityPrecheckResult {
  const fields = input.template?.fields ?? []
  const strs = stringValues(input.details)
  const freeText = [input.title, ...Object.values(strs)].join(' ')
  const notes: string[] = []

  const missingRequired = fields.filter((f) => f.required && !filled(strs[f.name])).map((f) => f.name)

  const gaps: RfqQualityGap[] = []
  // quantity — a digit anywhere satisfies it. Template-aware (FOLLOWUPS S1.5): six of
  // the eight seeded categories are professional services where "how many?" is noise,
  // so the gap fires only when the template names a quantity-like field (unfilled) or
  // there is no template at all.
  const noDigit = !/\d/.test(freeText)
  const qtyField = hasFieldMatching(fields, QTY_FIELD_RE)
  if (noDigit && !filledFieldMatching(fields, strs, QTY_FIELD_RE) && (qtyField || !input.template)) gaps.push('quantity')
  // location — same template awareness: a location-like field exists and is unfilled (a
  // required one is already in missingRequired) or no template; and no place token in the text.
  const locField = hasFieldMatching(fields, LOCATION_FIELD_RE)
  if (!filledFieldMatching(fields, strs, LOCATION_FIELD_RE) && (locField || !input.template) && !mentionsIndianPlace(freeText)) {
    const alreadyRequired = fields.some((f) => LOCATION_FIELD_RE.test(f.name) && f.required && missingRequired.includes(f.name))
    if (!alreadyRequired) gaps.push('location')
  }
  // timeline — needed_by null, no timeline-like field filled, no time words.
  if (!input.neededBy && !filledFieldMatching(fields, strs, TIMELINE_FIELD_RE) && !TIMELINE_TEXT_RE.test(freeText)) {
    const alreadyRequired = fields.some((f) => TIMELINE_FIELD_RE.test(f.name) && f.required && missingRequired.includes(f.name))
    if (!alreadyRequired) gaps.push('timeline')
  }
  // budget — both budget fields null and no budget-like template field filled (a gap, not a risk).
  if (input.budgetMinPaise == null && input.budgetMaxPaise == null && !filledFieldMatching(fields, strs, BUDGET_FIELD_RE)) gaps.push('budget')
  // specs — the template's free-text field (first textarea) is thin.
  const textarea = fields.find((f) => f.type === 'textarea')
  if (textarea && (strs[textarea.name] ?? '').trim().length < RFQ_QUALITY_SPECS_MIN_CHARS) {
    if (!missingRequired.includes(textarea.name)) gaps.push('specs')
  }

  const risks: RfqQualityRisk[] = []
  if ([input.title, ...Object.values(strs)].some((s) => redactContactInfo(s).redacted)) risks.push('contact_info_in_text')
  if (titleContentWords(input.title).length < 3) risks.push('title_too_vague')
  if (freeText.replace(/\s+/g, ' ').trim().length < RFQ_QUALITY_DESCRIPTION_MIN_CHARS) risks.push('description_too_short')
  // budget_below_floor — CATEGORIES carries no minBudgetPaise on this tree: rule skipped, noted.
  notes.push('budget_floor_unavailable')
  if (input.recentOpenSameCategory) risks.push('duplicate_recent')

  return { missingRequired, gaps, risks, notes }
}

// ── Stub / fallback questions (also the i18n source for template-required questions) ──

export const RFQ_QUALITY_STUB_QUESTIONS: Record<RfqQualityGap | 'required', Record<RfqQualityLocale, string>> = {
  required: {
    en: 'Please fill in: {label}',
    hi: 'कृपया भरें: {label}',
    ta: 'தயவுசெய்து நிரப்பவும்: {label}',
    te: 'దయచేసి పూరించండి: {label}',
  },
  quantity: {
    en: 'How many do you need (quantity, pages, units or people)?',
    hi: 'आपको कितनी संख्या चाहिए (मात्रा, पेज, यूनिट या लोग)?',
    ta: 'உங்களுக்கு எவ்வளவு தேவை (எண்ணிக்கை, பக்கங்கள், யூனிட் அல்லது நபர்கள்)?',
    te: 'మీకు ఎంత అవసరం (పరిమాణం, పేజీలు, యూనిట్లు లేదా వ్యక్తులు)?',
  },
  location: {
    en: 'Which city or state is this for?',
    hi: 'यह किस शहर या राज्य के लिए है?',
    ta: 'இது எந்த நகரம் அல்லது மாநிலத்திற்கானது?',
    te: 'ఇది ఏ నగరం లేదా రాష్ట్రం కోసం?',
  },
  timeline: {
    en: 'By when do you need this done?',
    hi: 'आपको यह काम कब तक चाहिए?',
    ta: 'இது எப்போதுக்குள் முடிக்கப்பட வேண்டும்?',
    te: 'ఇది ఎప్పటిలోగా పూర్తి కావాలి?',
  },
  budget: {
    en: 'Do you have a budget range in mind (even a rough one)?',
    hi: 'क्या आपके मन में कोई बजट सीमा है (लगभग भी चलेगा)?',
    ta: 'உங்கள் மனதில் ஒரு பட்ஜெட் வரம்பு உள்ளதா (தோராயமாகவும் போதும்)?',
    te: 'మీ మనసులో బడ్జెట్ పరిధి ఏదైనా ఉందా (సుమారుగా అయినా)?',
  },
  specs: {
    en: 'Can you add a few more details about what exactly you need?',
    hi: 'आपको ठीक-ठीक क्या चाहिए, इसके बारे में कुछ और विवरण दे सकते हैं?',
    ta: 'உங்களுக்கு சரியாக என்ன தேவை என்பது பற்றி இன்னும் சில விவரங்களைச் சேர்க்க முடியுமா?',
    te: 'మీకు సరిగ్గా ఏమి కావాలో దాని గురించి మరికొన్ని వివరాలు జోడించగలరా?',
  },
}

export function stubQuestionFor(field: string, locale: RfqQualityLocale, template: RfqTemplate | null): string {
  if ((RFQ_QUALITY_GAPS as readonly string[]).includes(field)) return RFQ_QUALITY_STUB_QUESTIONS[field as RfqQualityGap][locale]
  const f = template?.fields.find((x) => x.name === field)
  const label = f ? rfqFieldLabel(f, locale) : field.replace(/_/g, ' ')
  return RFQ_QUALITY_STUB_QUESTIONS.required[locale].replace('{label}', label)
}

// ── Merge (union rule) ───────────────────────────────────────────────────────

/** Model questions that ask for contact details are dropped whatever the prompt said. */
const CONTACT_REQUEST_RE = /whatsapp|phone|mobile number|contact number|email|call you|reach you|फोन|मोबाइल|ईमेल|व्हाट्सऐप|व्हाट्सएप|தொலைபேசி|மின்னஞ்சல்|ఫోన్|ఇమెయిల్/i

export interface MergeQualityOptions {
  locale: RfqQualityLocale
  template: RfqTemplate | null
  /** Override the fallback question for a field (e.g. i18n at the edge). Default: stub questions. */
  stubQuestions?: (field: string) => string
}

/**
 * Rule items first (missing required fields, then generic gaps), then model gaps
 * that add a NEW field, deduped by field, capped at three. The model can never
 * remove a rule item; when the rules alone exceed the cap the required fields win.
 * `complete` is simply "nothing to ask".
 */
export function mergeQualityReport(pre: RfqQualityPrecheckResult, model: RfqQualityModelOutput | null, opts: MergeQualityOptions): RfqQualityReport {
  const q = opts.stubQuestions ?? ((field: string) => stubQuestionFor(field, opts.locale, opts.template))
  const missing: RfqQualityMissing[] = []
  const seen = new Set<string>()
  const push = (item: RfqQualityMissing) => {
    if (seen.has(item.field) || missing.length >= RFQ_QUALITY_MAX_MISSING) return
    seen.add(item.field)
    missing.push(item)
  }
  for (const field of pre.missingRequired) push({ field, question: q(field), source: 'rule' })
  for (const gap of pre.gaps) push({ field: gap, question: q(gap), source: 'rule' })
  if (model) {
    for (const g of model.gaps) {
      const field = g.field.trim().slice(0, 60)
      const question = g.question.trim().slice(0, 160)
      if (!field || question.length < 5) continue
      if (CONTACT_REQUEST_RE.test(question)) continue
      push({ field, question, ...(g.why ? { why: g.why.trim().slice(0, 120) } : {}), source: 'model' })
    }
  }
  const risk_flags = pre.risks.slice(0, 5)
  return { complete: missing.length === 0, missing, risk_flags, locale: opts.locale }
}

/** The moment the cron guard will release a deferred RFQ as is. */
export function rfqQualityDeadline(createdAt: string | Date, holdMinutes: number): string {
  const t = typeof createdAt === 'string' ? new Date(createdAt).getTime() : createdAt.getTime()
  return new Date(t + holdMinutes * 60_000).toISOString()
}

/** Derived, never a status: an open RFQ that has not been fanned out yet. */
export function isRfqDeferred(rfq: { status: string; fanoutAt: string | null }): boolean {
  return rfq.status === 'open' && rfq.fanoutAt === null
}
