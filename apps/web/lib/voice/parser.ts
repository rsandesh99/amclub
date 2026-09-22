import 'server-only'
import {
  CATEGORY_LIST,
  SPECIALIZATIONS,
  isSpecializationOf,
  voiceParseSchema,
  type CategorySlug,
  type VoiceParse,
} from '@amclub/shared'
import { buildRfqParseParts, createGateway, getPrompt, loadDefaultPrompts, rfqParseModelOutputSchema } from '@amclub/agent-core'
import { INDIAN_STATES } from '@/lib/constants/india'
import { boundedChatJson } from '@/lib/agent/bounded'
import { resolveModel } from '@/lib/agent/router'
import type { ParseContext, ParseResult, RequirementParser } from './types'

/**
 * English requirement text → structured RFQ prefill (Phase 8b). S1.8 §1 moved
 * the prompt into the agent-core registry (`rfq_parse@v1` = the Phase 8b text;
 * `@v2` adds the prior-round section and runs only on the answer to the one
 * clarifying question) and the call onto the bounded helper: ONE temperature-0
 * gateway call, one ai_invocations row (feature voice_rfq, task rfq_parse),
 * the budget caps checked first. Output is Zod-validated and vocabulary-
 * clamped server-side exactly as before (`sanitize`) — an out-of-vocabulary
 * value never reaches the client, and a hedged guess is normalised to null.
 *
 * STUB without a key: the gateway's stub mode runs the same tiny keyword
 * heuristic as Phase 8b so the flow stays exercisable keyless (rows status
 * 'stub'). VOICE_PARSE_MODEL keeps its precedence (> AGENT_MODEL_ROUTINE >
 * default) through the gateway's per-call model override.
 */

const PARSE_MODEL_OVERRIDE = () => process.env['VOICE_PARSE_MODEL'] || ''
const parseModel = () => PARSE_MODEL_OVERRIDE() || resolveModel('rfq_parse').model
const hasKey = () => !!(process.env['AGENT_LLM_API_KEY'] || process.env['OPENROUTER_API_KEY']) && process.env['AGENT_LLM_STUB'] !== '1'

const VALID_STATES = new Set(INDIAN_STATES.map((s) => s.value))
const PARSE_VOCAB = {
  categories: CATEGORY_LIST.map((c) => ({ slug: c.slug, description: c.description_i18n.en })),
  specializations: SPECIALIZATIONS,
  states: INDIAN_STATES.map((s) => ({ value: s.value, label: s.label })),
}

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
  // The inverse clamp: clients never prefill a category the model marked
  // uncertain (web leaves it unset; mobile must behave identically), so a
  // "hedged guess" (uncertain=true + category filled) is normalised to null.
  if (p.uncertain) {
    p.category_slug = null
    p.specialization = null
  }
  return p
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

/** The keyless heuristic as a gateway stub producer (raw shape; sanitize runs after). */
function stubDraft(englishText: string, prior: ParseContext['prior']): Record<string, unknown> {
  const text = prior ? `${prior.transcript_english} ${englishText}` : englishText
  const hit = STUB_KEYWORDS.find(([, , re]) => re.test(text))
  const state = STUB_CITY_STATES.find(([re]) => re.test(text))?.[1] ?? null
  if (prior) {
    // Round two: start from the prior parse, fill only what the answer adds, never revert.
    return {
      category_slug: prior.parse.category_slug ?? hit?.[0] ?? null,
      specialization: prior.parse.specialization ?? hit?.[1] ?? null,
      state: prior.parse.state ?? state,
      description_english: `${prior.parse.description_english} ${englishText}`.slice(0, 2000),
      uncertain: !(prior.parse.category_slug ?? hit?.[0]),
    }
  }
  return {
    category_slug: hit?.[0] ?? null,
    specialization: hit?.[1] ?? null,
    state,
    description_english: englishText.slice(0, 2000),
    uncertain: !hit,
  }
}

let promptsLoaded = false
function ensurePrompts(): void {
  if (promptsLoaded) return
  loadDefaultPrompts()
  promptsLoaded = true
}

class BoundedParser implements RequirementParser {
  async parse(englishText: string, originalLanguage: string, ctx?: ParseContext): Promise<ParseResult> {
    ensurePrompts()
    const prior = ctx?.prior ?? null
    const version = prior ? 'v2' : 'v1'
    const parts = buildRfqParseParts({
      transcript: englishText,
      transcriptId: prior ? 'answer' : 'clip',
      originalLanguage,
      ...PARSE_VOCAB,
      ...(prior ? { prior, answerTyped: ctx?.answerTyped === true } : {}),
    })
    const stub = () => stubDraft(englishText, prior)
    const override = PARSE_MODEL_OVERRIDE()
    if (!hasKey()) {
      console.warn(`[voice:parse STUB] would parse via the gateway (rfq_parse@${version}) → "${englishText.slice(0, 80)}…" (no LLM key)`)
    }
    let raw: unknown
    let model = 'stub'
    let isStub = true
    if (ctx) {
      const res = await boundedChatJson(ctx.admin, {
        userId: ctx.userId,
        feature: 'voice_rfq',
        taskClass: 'rfq_parse',
        promptId: 'rfq_parse',
        promptVersion: version,
        schema: rfqParseModelOutputSchema,
        parts,
        temperature: 0,
        stub,
        meta: { original_language: originalLanguage, round: prior ? 2 : 1, input_chars: englishText.length },
        ...(override ? { model: override } : {}),
      })
      raw = res.data
      model = res.model
      isStub = res.stub
    } else {
      // No context (the golden eval, in-process): the gateway directly, no ledger row, no budget.
      const res = await createGateway().chatJson({
        taskClass: 'rfq_parse',
        prompt: getPrompt('rfq_parse', version),
        schema: rfqParseModelOutputSchema,
        parts,
        temperature: 0,
        stub,
        ...(override ? { model: override } : {}),
      })
      raw = res.data
      model = res.model
      isStub = res.stub
    }
    const parse = sanitize(raw, originalLanguage)
    if (!parse) throw new Error('rfq_parse: response failed schema validation')
    return { parse, vendor: isStub ? 'stub' : `gateway:${model}`, stub: isStub }
  }
}

export function getParser(): RequirementParser {
  return new BoundedParser()
}

/** Vendor tag for telemetry when the call itself failed (no result object). */
export function parserVendorTag(): string {
  return hasKey() ? `gateway:${parseModel()}` : 'stub'
}

/** Exposed for the S1.8 verify script (offline): the clamp is unchanged from Phase 8b. */
export const __sanitizeForTests = sanitize
