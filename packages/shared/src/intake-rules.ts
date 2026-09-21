import type { RfqTemplate, RfqTemplateField } from './rfq'
import { RFQ_QUALITY_DESCRIPTION_MIN_CHARS, mentionsIndianPlace } from './rfq-quality'
import type { VoiceParse } from './schemas/index'

/**
 * S1.8 — the ONE rule that decides whether a voice parse earns its single
 * clarifying question. Pure and tested. Priority: category > a template-
 * required field the description does not cover > scope (too thin) > state.
 * "Covers" is a field-name / label keyword match against the English
 * description (the S1.5 precheck's field families for quantity, location,
 * timeline and budget), never a model judgement. A request carrying `prior`
 * never reaches this rule (the route enforces one round).
 */

export interface ClarifyNeed {
  /** 'category' | 'state' | 'scope' | the template field name. */
  gap: string
  field?: RfqTemplateField
}

const QTY_RE = /qty|quantity|count|units|pages|pieces|headcount|number_of|how_many/i
const LOCATION_RE = /state|city|location|site|address|pincode|district/i
const TIMELINE_RE = /urgency|timeline|deadline|needed_by|when|by_when|start_date/i
const BUDGET_RE = /budget|loan_amount|amount|turnover|salary/i
const TIME_WORDS_RE = /\b(?:\d+\s*)?(?:days?|weeks?|months?|by |before|urgent|asap|immediately|tomorrow|today|this week|next week|jaldi|turant)\b/i
const MONEY_RE = /₹|\brs\.?\b|rupee|lakh|lac|crore|\bk\b|\d/i
const STOP = new Set(['the', 'and', 'for', 'of', 'type', 'name', 'any', 'other', 'details', 'additional', 'your', 'you', 'what', 'which', 'please', 'required'])

/** Keywords a field is recognised by in prose: its name tokens + its English label words (≥ 3 chars, no stop words). */
export function fieldKeywords(f: RfqTemplateField): string[] {
  const words = [...f.name.split(/[_\s-]+/), ...(f.label_en ?? '').split(/[^A-Za-z0-9]+/)]
  const out = new Set<string>()
  for (const w of words) {
    const k = w.toLowerCase()
    if (k.length >= 3 && !STOP.has(k)) out.add(k)
  }
  return [...out]
}

/** Does the English description already cover this field? Family rules first, keyword match otherwise. */
export function fieldCoveredByText(f: RfqTemplateField, text: string): boolean {
  const t = ` ${text.toLowerCase()} `
  if (QTY_RE.test(f.name)) return /\d/.test(text)
  if (LOCATION_RE.test(f.name)) return mentionsIndianPlace(text)
  if (TIMELINE_RE.test(f.name)) return TIME_WORDS_RE.test(text)
  if (BUDGET_RE.test(f.name)) return MONEY_RE.test(text)
  if (f.type === 'select' && f.options?.length) {
    if (f.options.some((o) => o.length >= 3 && t.includes(` ${o.toLowerCase()} `))) return true
  }
  return fieldKeywords(f).some((k) => t.includes(k))
}

export function needsClarification(parse: VoiceParse, template: RfqTemplate | null): ClarifyNeed | null {
  if (!parse.category_slug || parse.uncertain) return { gap: 'category' }
  const text = parse.description_english ?? ''
  for (const f of template?.fields ?? []) {
    if (!f.required || f.name === 'additional_details' || f.type === 'textarea') continue
    if (!fieldCoveredByText(f, text)) return { gap: f.name, field: f }
  }
  if (text.replace(/\s+/g, ' ').trim().length < RFQ_QUALITY_DESCRIPTION_MIN_CHARS) return { gap: 'scope' }
  if (!parse.state && !mentionsIndianPlace(text)) return { gap: 'state' }
  return null
}

/** The per-gap keyword each clarifying question must carry (eval + rig assertion), by target language. */
export const CLARIFY_GAP_KEYWORDS: Record<'en' | 'hi' | 'te' | 'ta', Record<'category' | 'state' | 'scope', string[]>> = {
  en: { category: ['service', 'help', 'need', 'work'], state: ['state', 'city', 'where', 'location'], scope: ['exactly', 'detail', 'what', 'describe'] },
  hi: { category: ['सेवा', 'काम', 'मदद', 'चाहिए'], state: ['राज्य', 'शहर', 'कहाँ', 'कहां', 'जगह'], scope: ['विस्तार', 'क्या', 'बताएं', 'बताइए'] },
  te: { category: ['సేవ', 'పని', 'సహాయం', 'కావాలి'], state: ['రాష్ట్రం', 'నగరం', 'ఎక్కడ', 'ఊరు'], scope: ['వివరం', 'ఏమిటి', 'చెప్పండి', 'వివరించండి'] },
  ta: { category: ['சேவை', 'வேலை', 'உதவி', 'வேண்டும்'], state: ['மாநிலம்', 'நகரம்', 'எங்கே', 'ஊர்'], scope: ['விவரம்', 'என்ன', 'சொல்லுங்கள்', 'விளக்க'] },
}

/** Script ranges per target language (the question must be in the buyer's script). */
export const CLARIFY_SCRIPT_RE: Record<'en' | 'hi' | 'te' | 'ta', RegExp> = {
  en: /[A-Za-z]/,
  hi: /[ऀ-ॿ]/,
  te: /[ఀ-౿]/,
  ta: /[஀-௿]/,
}

/** Keyless stub / model-failure fallback: a fixed question per gap and language (the eval keywords hold for it). */
export function stubClarifyQuestion(gap: string, locale: 'en' | 'hi' | 'te' | 'ta', fieldLabel?: string | null): { question: string; gap: string; locale: string } {
  const Q: Record<'en' | 'hi' | 'te' | 'ta', Record<'category' | 'state' | 'scope', string> & { field: (l: string) => string }> = {
    en: { category: 'What work do you need done — which service are you looking for?', state: 'Which state or city is this work for?', scope: 'Can you describe the work in one more sentence — what exactly, how much, and by when?', field: (l) => `Could you tell me your ${l}?` },
    hi: { category: 'आपको कौन सा काम करवाना है — किस सेवा की ज़रूरत है?', state: 'यह काम किस राज्य या शहर के लिए है?', scope: 'काम को एक और वाक्य में बताएं — क्या, कितना और कब तक?', field: (l) => `कृपया बताएं: ${l}?` },
    te: { category: 'మీకు ఏ పని చేయించాలి — ఏ సేవ కావాలి?', state: 'ఈ పని ఏ రాష్ట్రం లేదా నగరం కోసం?', scope: 'పనిని ఇంకో వాక్యంలో చెప్పండి — ఏమిటి, ఎంత, ఎప్పటిలోగా?', field: (l) => `దయచేసి చెప్పండి: ${l}?` },
    ta: { category: 'உங்களுக்கு என்ன வேலை செய்ய வேண்டும் — எந்த சேவை வேண்டும்?', state: 'இந்த வேலை எந்த மாநிலம் அல்லது நகரத்திற்கு?', scope: 'வேலையை இன்னொரு வாக்கியத்தில் சொல்லுங்கள் — என்ன, எவ்வளவு, எப்போதுக்குள்?', field: (l) => `தயவுசெய்து சொல்லுங்கள்: ${l}?` },
  }
  const q = Q[locale]
  const question = gap === 'category' || gap === 'state' || gap === 'scope' ? q[gap] : q.field((fieldLabel ?? gap.replace(/_/g, ' ')).slice(0, 60))
  return { question: question.slice(0, 200), gap, locale }
}

/** STT BCP-47 code → clarify target language (te-IN → te; unknown → en). */
export function clarifyLocaleFor(languageCode: string | null | undefined): 'en' | 'hi' | 'te' | 'ta' {
  const base = (languageCode ?? '').toLowerCase().split('-')[0]
  return base === 'hi' || base === 'te' || base === 'ta' ? base : 'en'
}
