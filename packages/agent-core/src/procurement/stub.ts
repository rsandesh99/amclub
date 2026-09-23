import {
  PROCUREMENT_LOCALES,
  labelMentioned,
  type ClarificationAnswerDraft,
  type ProcurementTurn,
  type ProviderMessageDraft,
  type QuoteDeclineReason,
} from '@amclub/shared'

/**
 * The keyless producers (S3.1): deterministic, honest stand-ins for the three
 * procurement prompts, used when no LLM key is configured (the rig, CI, a dark
 * deploy). Same shapes as the models' output; no reply text. The turn stub
 * reads only what code can see (keywords, the letters actually written); the
 * clarification stub answers only from a buyer turn that shares the question's
 * key terms; the message stub restates the buyer's words so the
 * no-negotiation clamp — not the stub — decides what may be proposed.
 */

export interface TurnStubContext {
  state: string | null
  hasRequest: boolean
  quoteLabels: readonly string[]
  waitingFor: 'none' | 'clarify_answer' | 'quality_answers' | 'relay_answer' | 'label_pick'
}

const CHOOSE = /(go with|go ahead with|choose|chose|select|pick|let'?s do|take|finali[sz]e|book|confirm|chalo|wala|वाला|वाले|ले लो|వెళ్దాం|ఎంచుకో|உடன் செல்|தேர்ந்தெடு)/i
const DECLINE = /(decline|reject|not interested|don'?t want|no to|nahi chahiye|नहीं चाहिए|मना|వద్దు|வேண்டாம்)/i
const ASK = /(ask (him|her|them|the provider|provider|[a-g]\b)|tell (him|her|them|[a-g]\b)|puchh|pucho|पूछो|पूछिए|అడగండి|கேளுங்கள்|can you check with)/i
const STATUS = /(status|any quotes|quotes yet|update|kya hua|क्या हुआ|what happened|ఏమైంది|என்ன ஆச்சு)/i
const ESCALATE = /(fraud|cheated|scam|dhokha|money deducted|charged twice|human|real person|complain)/i
const NEED = /(i need|we need|need a |need an |looking for|require|want a |want an |want to get|chahiye|चाहिए|kavali|కావాలి|vendum|வேண்டும்)/i
const GREETING = /^(hi|hello|hey|namaste|thanks|thank you|ok|okay|dhanyavad|shukriya|vanakkam|namaskaram)\b[\s!.]*$/i

function firstLabel(text: string, labels: readonly string[]): string | null {
  for (const l of labels) if (labelMentioned(text, l)) return l
  return null
}

function declineReason(t: string): QuoteDeclineReason {
  if (/(costly|expensive|price|mehenga|महंगा|ఖరీదు|விலை அதிகம்|too high)/i.test(t)) return 'price_high'
  if (/(slow|late|delivery|time|देर|ఆలస్యం|தாமதம்)/i.test(t)) return 'delivery_slow'
  if (/(unclear|not clear|confus|समझ नहीं)/i.test(t)) return 'details_unclear'
  if (/(terms|advance|conditions|शर्त)/i.test(t)) return 'terms_unacceptable'
  return 'other'
}

export function stubProcurementTurn(text: string, ctx: TurnStubContext): ProcurementTurn {
  const t = text.trim()
  const base: ProcurementTurn = { route: 'other', session_ref: null, choose_label: null, decline_label: null, decline_reason: null, provider_question: null, escalate_to_support: false }
  if (!t) return base
  if (ESCALATE.test(t)) return { ...base, escalate_to_support: true }
  const live = ctx.quoteLabels.length > 0
  if (live && DECLINE.test(t) && !ASK.test(t)) return { ...base, route: 'decline', session_ref: 'current', decline_label: firstLabel(t, ctx.quoteLabels), decline_reason: declineReason(t) }
  if (live && ASK.test(t)) return { ...base, route: 'ask_provider', session_ref: 'current', choose_label: firstLabel(t, ctx.quoteLabels), provider_question: t.slice(0, 300) }
  if (live && (CHOOSE.test(t) || firstLabel(t, ctx.quoteLabels) || /(cheap|fast|second|first|sasta|jaldi)/i.test(t))) return { ...base, route: 'choose', session_ref: 'current', choose_label: firstLabel(t, ctx.quoteLabels) }
  if (STATUS.test(t)) return { ...base, route: 'status', session_ref: ctx.hasRequest ? 'current' : null }
  if (ctx.waitingFor !== 'none' && ctx.waitingFor !== 'label_pick' && !GREETING.test(t)) return { ...base, route: 'answer_to_agent', session_ref: 'current' }
  if (NEED.test(t) && ctx.hasRequest && ctx.state && !['drafting', 'awaiting_create'].includes(ctx.state)) return { ...base, route: 'new_need', session_ref: 'new' }
  if (NEED.test(t)) return { ...base, route: 'new_need', session_ref: ctx.hasRequest ? 'new' : null }
  if ((ctx.state === 'drafting' || ctx.state === 'awaiting_create') && !GREETING.test(t) && t.length >= 6) return { ...base, route: 'need_detail', session_ref: 'current' }
  return base
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'do', 'you', 'your', 'how', 'many', 'what', 'which', 'when', 'will', 'can', 'for', 'of', 'to', 'in', 'on', 'and', 'or', 'it', 'this', 'that', 'there', 'be', 'need', 'have', 'has', 'does', 'please', 'with', 'from', 'any', 'kya', 'hai', 'ka', 'ki', 'ke', 'me', 'se'])
const words = (s: string) => s.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP_WORDS.has(w))

/** Answer only from a buyer turn sharing ≥ 1 key term with the question (and never a digit-free guess). */
export function stubClarificationAnswer(question: string, turns: readonly { id: string; text: string }[]): ClarificationAnswerDraft {
  const q = new Set(words(question))
  for (const t of [...turns].reverse()) {
    const hit = words(t.text).some((w) => q.has(w))
    if (hit) return { answerable: true, answer: t.text.trim().slice(0, 300), source_turn_ids: [t.id] }
  }
  return { answerable: false, answer: null, source_turn_ids: [] }
}

const ASK_PREFIX = /^(please\s+)?(ask|tell)\s+(him|her|them|the provider|provider|[a-g])\s*(if|whether|to|that)?\s*/i

/** Restate the buyer's words (minus "ask him …"): the clamp, not the stub, decides whether it may be proposed. */
export function stubProviderMessage(text: string): ProviderMessageDraft {
  const body = text.trim().replace(ASK_PREFIX, '').trim()
  const q = body ? body.charAt(0).toUpperCase() + body.slice(1) : text.trim()
  return { body: q.slice(0, 600) || 'Could you share a little more detail about your quote?' }
}

export const PROCUREMENT_STUB_LOCALES = PROCUREMENT_LOCALES
