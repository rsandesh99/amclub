import 'server-only'
import {
  CATEGORY_LIST,
  CATEGORY_SLUGS,
  SPECIALIZATIONS,
  isSpecializationOf,
  voiceParseSchema,
  type CategorySlug,
  type VoiceParse,
} from '@amclub/shared'
import { INDIAN_STATES } from '@/lib/constants/india'
import { VendorHttpError } from './types'
import type { ParseResult, RequirementParser } from './types'

/**
 * English requirement text → structured RFQ prefill (Phase 8b), via ONE
 * temperature-0 OpenRouter chat call returning strict JSON. The prompt
 * enumerates the real category slugs, the curated specialization vocabulary,
 * and the state codes; the model must return uncertain=true rather than
 * guess. Output is Zod-validated and vocabulary-clamped server-side — an
 * out-of-vocabulary value never reaches the client.
 *
 * STUB when OPENROUTER_API_KEY is unset — logs "would parse" and runs a tiny
 * keyword heuristic so the flow stays exercisable keyless.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite'

const SYSTEM_PROMPT = `You convert an Indian MSME owner's spoken service requirement (already translated to English) into strict JSON for a B2B services marketplace RFQ form. Return ONLY a JSON object — no prose, no code fences.

Categories (pick exactly one slug, or null):
${CATEGORY_LIST.map((c) => `- ${c.slug}: ${c.description_i18n.en}`).join('\n')}

Specializations per category (pick one from the chosen category's list, or null):
${CATEGORY_SLUGS.map((s) => `- ${s}: ${SPECIALIZATIONS[s].join(', ')}`).join('\n')}

Indian state codes (pick one if a state/city is mentioned or clearly implied, else null):
${INDIAN_STATES.map((s) => `${s.value}=${s.label}`).join(', ')}

Output shape:
{"category_slug": string|null, "specialization": string|null, "state": string|null, "description_english": string, "uncertain": boolean}

Rules:
- description_english: a clean 1-3 sentence restatement of the requirement, keeping concrete facts (business type, city, quantities, deadlines).
- If the text does not clearly fit one category, or is vague/off-topic, set category_slug=null, specialization=null and uncertain=true. NEVER guess.
- The bar for uncertain=false is a CONCRETE, ACTIONABLE service request: the speaker names (or unmistakably describes) a specific task a provider could quote — "file my GST returns", "need 15 tailors", "register our trademark".
- A topic hint is NOT enough. Complaints, musings, or requests to "explain/fix/sort out" an unspecified problem ("staff situation is bad", "a notice came, please help", "get the paperwork sorted", "do something online") are uncertain=true with category_slug=null, even when the general domain seems guessable. A wrong prefill costs the user more than an empty form.
- Examples of MUST-be-uncertain inputs: "there was some problem with the tax people last month, my cousin said talk to someone" → {"category_slug": null, "specialization": null, "uncertain": true}; "business needs to grow, what all services do you have" → {"category_slug": null, "specialization": null, "uncertain": true}.
- uncertain=false only when the category is unambiguous AND the request is concrete.
- specialization must come from the chosen category's list above; otherwise null.
- state: map cities to their state (e.g. Guntur→AP, Coimbatore→TN, Indore→MP). null if none mentioned.`

const VALID_STATES = new Set(INDIAN_STATES.map((s) => s.value))

/** Clamp an LLM (or heuristic) draft to schema + curated vocabulary. */
function sanitize(raw: unknown, originalLanguage: string): VoiceParse | null {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const draft = voiceParseSchema.safeParse({
    category_slug: obj['category_slug'] ?? null,
    specialization: obj['specialization'] ?? null,
    state: obj['state'] ?? null,
    description_english: obj['description_english'] ?? '',
    original_language: originalLanguage,
    uncertain: obj['uncertain'] ?? true,
  })
  if (!draft.success) return null
  const p = draft.data
  if (p.state && !VALID_STATES.has(p.state)) p.state = null
  if (p.specialization && (!p.category_slug || !isSpecializationOf(p.category_slug, p.specialization))) {
    p.specialization = null
  }
  if (!p.category_slug) p.uncertain = true
  return p
}

class OpenRouterParser implements RequirementParser {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async parse(englishText: string, originalLanguage: string): Promise<ParseResult> {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        // Ask OpenRouter to include token usage + cost in the response
        // (ai_invocations cost observability — §Phase 8b v1.1).
        usage: { include: true },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: englishText },
        ],
      }),
    })
    if (!res.ok) {
      // 402 = no prepaid credits, 429 = rate/quota — classified for the user
      // and captured in full for ai_invocations.
      const body = await res.text().catch(() => '')
      throw new VendorHttpError('openrouter', res.status, body)
    }
    const d = (await res.json()) as {
      id?: string
      usage?: Record<string, unknown>
      choices?: { message?: { content?: string } }[]
    }
    const content = d.choices?.[0]?.message?.content ?? ''
    // Defensive: some models fence JSON despite response_format.
    const jsonText = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    let raw: unknown
    try {
      raw = JSON.parse(jsonText)
    } catch {
      throw new Error('openrouter: non-JSON response')
    }
    const parse = sanitize(raw, originalLanguage)
    if (!parse) throw new Error('openrouter: response failed schema validation')
    return {
      parse,
      vendor: `openrouter:${this.model}`,
      stub: false,
      requestId: d.id ?? null,
      usage: d.usage,
    }
  }
}

/** Keyword heuristic — keeps the keyless dev loop honest: matches only very
 *  explicit phrases, everything else comes back uncertain (never a guess). */
const STUB_KEYWORDS: [CategorySlug, string, RegExp][] = [
  ['company-registrations', 'gst-registration', /gst registration|register.*gst|new gst number/i],
  ['company-registrations', 'pvt-ltd-incorporation', /private limited|pvt ltd|incorporat/i],
  ['company-registrations', 'fssai-license', /fssai/i],
  ['company-registrations', 'udyam-registration', /udyam/i],
  ['tax-accounting', 'gst-filing', /gst (monthly |return |)filing|file.*gst return/i],
  ['tax-accounting', 'itr-filing', /income tax return|itr/i],
  ['tax-accounting', 'bookkeeping', /bookkeep|accounts maintenance/i],
  ['legal', 'trademark', /trademark|brand registration/i],
  ['legal', 'contract-drafting', /contract|agreement draft/i],
  ['hr-staffing', 'recruitment', /hire|recruit|staffing|workers needed/i],
  ['hr-staffing', 'payroll', /payroll|salary processing/i],
  ['finance-facilitation', 'mudra-application', /mudra/i],
  ['finance-facilitation', 'loan-documentation', /loan/i],
  ['digital-marketing', 'social-media', /instagram|facebook|social media/i],
  ['digital-marketing', 'seo', /\bseo\b|google ranking/i],
  ['web-tech', 'website-development', /website/i],
  ['web-tech', 'ecommerce-setup', /e-?commerce|online store|amazon|flipkart/i],
  ['government-licensing', 'factory-license', /factory licen/i],
  ['government-licensing', 'pollution-noc', /pollution/i],
]

const STUB_CITY_STATES: [RegExp, string][] = [
  [/guntur|vijayawada|visakhapatnam|andhra/i, 'AP'],
  [/hyderabad|warangal|telangana/i, 'TS'],
  [/bengaluru|bangalore|mysore|karnataka/i, 'KA'],
  [/chennai|coimbatore|madurai|tamil nadu/i, 'TN'],
  [/mumbai|pune|nagpur|maharashtra/i, 'MH'],
  [/delhi/i, 'DL'],
]

class StubParser implements RequirementParser {
  async parse(englishText: string, originalLanguage: string): Promise<ParseResult> {
    console.warn(
      `[voice:parse STUB] would parse via OpenRouter → "${englishText.slice(0, 80)}…" (no OPENROUTER_API_KEY)`,
    )
    const hit = STUB_KEYWORDS.find(([, , re]) => re.test(englishText))
    const state = STUB_CITY_STATES.find(([re]) => re.test(englishText))?.[1] ?? null
    const parse = sanitize(
      {
        category_slug: hit?.[0] ?? null,
        specialization: hit?.[1] ?? null,
        state,
        description_english: englishText.slice(0, 2000),
        uncertain: !hit,
      },
      originalLanguage,
    )!
    return { parse, vendor: 'stub', stub: true }
  }
}

export function getParser(): RequirementParser {
  const key = process.env['OPENROUTER_API_KEY']
  if (!key) return new StubParser()
  return new OpenRouterParser(key, process.env['VOICE_PARSE_MODEL'] || DEFAULT_MODEL)
}

/** Vendor tag for telemetry when the call itself failed (no result object). */
export function parserVendorTag(): string {
  return process.env['OPENROUTER_API_KEY']
    ? `openrouter:${process.env['VOICE_PARSE_MODEL'] || DEFAULT_MODEL}`
    : 'stub'
}
