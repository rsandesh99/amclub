/**
 * S3.1 — the Buyer Procurement Agent contract (BUILD_PROMPTS S3.1, A2; built
 * dark, enablement at the DESIGN §8.2 V1.5→V2 gate).
 *
 * The buyer's own agent: it drafts a request, asks before creating it, then
 * watches it — relays provider questions, summarises quotes, and when the buyer
 * says "go with B" sends them to the ORDINARY checkout page with that quote
 * selected. Four laws are code here, never a prompt:
 *
 *   1. It never pays and never accepts. Acceptance in this codebase IS the
 *      buyer's paid checkout; `accept_quote` and `place_order` are not in
 *      `PROCUREMENT_SCOPES`, so a procurement token can never reach
 *      `POST /checkout` (its `requireToolScope('place_order')` refuses). "Go with
 *      B" is the LOCAL confirm gate `choose_quote` whose only effect is a link.
 *   2. It never negotiates price (§8.3 NOT-NOW "per-buyer price negotiation").
 *      `clampProviderMessage` rejects any drafted provider message carrying a
 *      currency amount, a percentage or counter-offer phrasing, in any locale.
 *   3. The model writes no sentence the buyer reads. `procurementTurnSchema` has
 *      no reply field; every message is a template from `procurement-copy.ts`.
 *   4. Money-adjacent choices need a button: `choose_quote`, `decline_quote` and
 *      the chase `nudge_counterparty` confirm ONLY by a button / web tap; the
 *      voice allow-list (`isUnambiguousYes`) may confirm the rest.
 *
 * Money in paise. Locales en / hi / te / ta.
 */
import { z } from 'zod'
import { uuidSchema } from './schemas/index'
import { QUOTE_DECLINE_REASONS, type QuoteDeclineReason } from './decline-message'
import { compareLabel, type CompareFlag, type CompareQuoteResult } from './compare'
import { formatRupees } from './munshi'
import { foldOutputDigits } from './output-policy'

// ── scopes ───────────────────────────────────────────────────────────────────

/** The buyer grant the procurement agent runs under (⊆ toolsForPersona('buyer')). No accept_quote, no place_order — ever. */
export const PROCUREMENT_SCOPES = [
  'search_catalog',
  'draft_rfq',
  'clarify_rfq',
  'extract_document',
  'create_rfq',
  'complete_rfq',
  'answer_clarification',
  'compare_quotes',
  'decline_quote',
  'choose_quote',
  'message_provider',
  'nudge_counterparty',
  'track_order',
  'support_lookup',
] as const
export type ProcurementScope = (typeof PROCUREMENT_SCOPES)[number]

/** The buyer tools a procurement grant must never carry (asserted in tests and by the enable route). */
export const PROCUREMENT_FORBIDDEN_TOOLS = ['accept_quote', 'place_order'] as const

/** A grant (or a union of grants) that lets the procurement agent run. */
export function hasProcurementScopes(scopes: readonly string[] | null | undefined): boolean {
  return !!scopes && scopes.includes('create_rfq') && scopes.includes('compare_quotes') && scopes.includes('choose_quote')
}

/** The tools a spoken / typed "yes" (the S2.2 allow-list, `isUnambiguousYes`) may confirm. Everything else needs a button or web tap. */
export const PROCUREMENT_VOICE_CONFIRM_TOOLS = ['create_rfq', 'complete_rfq', 'answer_clarification', 'message_provider'] as const
/** Money-adjacent: a button / web tap only. */
export const PROCUREMENT_BUTTON_ONLY_TOOLS = ['choose_quote', 'decline_quote', 'nudge_counterparty'] as const
export type ProcurementProposalTool = (typeof PROCUREMENT_VOICE_CONFIRM_TOOLS)[number] | (typeof PROCUREMENT_BUTTON_ONLY_TOOLS)[number]

export function voiceMayConfirm(tool: string): boolean {
  return (PROCUREMENT_VOICE_CONFIRM_TOOLS as readonly string[]).includes(tool)
}

export const PROCUREMENT_LOCALES = ['en', 'hi', 'te', 'ta'] as const
export type ProcurementLocale = (typeof PROCUREMENT_LOCALES)[number]
export function toProcurementLocale(l: string | null | undefined): ProcurementLocale {
  const base = (l ?? 'en').toLowerCase().split(/[-_]/)[0] ?? 'en'
  return (PROCUREMENT_LOCALES as readonly string[]).includes(base) ? (base as ProcurementLocale) : 'en'
}

/** Consent text version snapshotted on the grant when a buyer enables the assistant. */
export const PROCUREMENT_CONSENT_TEXT_VERSION = 'procurement-v1-2026-09-23'

/** Surfaces a session can start on (procurement_sessions.surface). */
export const PROCUREMENT_SURFACES = ['whatsapp', 'web', 'mobile'] as const
export type ProcurementSurface = (typeof PROCUREMENT_SURFACES)[number]

/** Turn roles (procurement_turns.role). */
export const PROCUREMENT_TURN_ROLES = ['user', 'agent', 'system'] as const
export type ProcurementTurnRole = (typeof PROCUREMENT_TURN_ROLES)[number]

/** A turn body stored for the web mirror is capped (and contact-masked by the writer). */
export const PROCUREMENT_TURN_BODY_MAX = 2000

// ── the per-turn classifier (no reply text, by design) ───────────────────────

export const PROCUREMENT_TURN_ROUTES = ['new_need', 'need_detail', 'answer_to_agent', 'choose', 'decline', 'ask_provider', 'status', 'other'] as const
export type ProcurementTurnRoute = (typeof PROCUREMENT_TURN_ROUTES)[number]

const quoteLabel = z.string().regex(/^[A-G]$/)

export const procurementTurnSchema = z
  .object({
    route: z.enum(PROCUREMENT_TURN_ROUTES),
    /** 'current' = about the active session's request; 'new' = a different need; null = no opinion. */
    session_ref: z.enum(['current', 'new']).nullable(),
    choose_label: quoteLabel.nullable(),
    decline_label: quoteLabel.nullable(),
    decline_reason: z.enum(QUOTE_DECLINE_REASONS).nullable(),
    /** The buyer's question for a provider, restated (≤ 300). Never sent as is: provider_message@v1 drafts, the clamp checks, the buyer confirms. */
    provider_question: z.string().max(300).nullable(),
    escalate_to_support: z.boolean(),
  })
  .strict()
export type ProcurementTurn = z.infer<typeof procurementTurnSchema>

/** `chose_other` is reserved for the system path (the decline route refuses it); a model's `chose_other` becomes `other`. */
export function procurementDeclineReason(r: QuoteDeclineReason | null): Exclude<QuoteDeclineReason, 'chose_other'> {
  if (!r || r === 'chose_other') return 'other'
  return r
}

// ── the clarification-answer draft ───────────────────────────────────────────

export const clarificationAnswerDraftSchema = z
  .object({
    answerable: z.boolean(),
    answer: z.string().min(1).max(1000).nullable(),
    /** The buyer's own earlier turns the answer is taken from (ids as given in the trusted list). */
    source_turn_ids: z.array(uuidSchema).max(5),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.answerable && (!d.answer || d.source_turn_ids.length === 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answer'], message: 'answerable needs an answer and ≥ 1 source turn' })
    if (!d.answerable && d.answer !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answer'], message: 'not answerable ⇒ answer null' })
  })
export type ClarificationAnswerDraft = z.infer<typeof clarificationAnswerDraftSchema>

/**
 * Code backstop for "answerable only when the buyer's own stated facts contain the answer": every cited turn must be
 * one of the buyer's own turns the prompt was given, and the answer must not introduce a price. Anything else → not
 * answerable (the question is relayed to the buyer verbatim-masked instead).
 */
export function acceptClarificationDraft(d: ClarificationAnswerDraft, buyerTurnIds: readonly string[], locale: ProcurementLocale | string = 'en'): ClarificationAnswerDraft {
  const known = new Set(buyerTurnIds)
  if (!d.answerable || !d.answer) return { answerable: false, answer: null, source_turn_ids: [] }
  if (!d.source_turn_ids.length || !d.source_turn_ids.every((id) => known.has(id))) return { answerable: false, answer: null, source_turn_ids: [] }
  if (!clampProviderMessage(d.answer, locale).ok) return { answerable: false, answer: null, source_turn_ids: [] }
  return d
}

// ── provider messages: the no-negotiation clamp ──────────────────────────────

export const providerMessageDraftSchema = z.object({ body: z.string().min(1).max(600) }).strict()
export type ProviderMessageDraft = z.infer<typeof providerMessageDraftSchema>

/**
 * Counter-offer phrasing per locale (Latin transliterations beside the native script). EVERY list is checked whatever
 * the locale: a buyer may write Hinglish in an English session. Matched as whole words after `normaliseForClamp`.
 */
export const COUNTER_OFFER_PHRASES: Record<ProcurementLocale, readonly string[]> = {
  en: [
    'can you do it for', 'can you do for', 'could you do it for', 'do it for', 'will you do it for', 'best price', 'lowest price', 'final price', 'last price', 'best rate', 'final rate', 'last rate',
    'reduce the price', 'reduce price', 'reduce your price', 'reduce the rate', 'lower the price', 'lower your price', 'lower price', 'bring down the price', 'bring the price down', 'bring it down',
    'price down', 'come down', 'discount', 'cheaper', 'match the price', 'match this price', 'match that price', 'beat this price', 'beat the price', 'negotiate', 'negotiable', 'negotiation',
    'counter offer', 'counteroffer', 'deal at', 'meet me at', 'meet halfway', 'concession', 'my budget is only', 'budget is only', 'too expensive', 'too costly', 'less money', 'for less',
  ],
  hi: [
    'kam karo', 'kam kar do', 'kam kijiye', 'kam kariye', 'kuch kam', 'thoda kam', 'rate kam', 'daam kam', 'dam kam', 'kimat kam', 'keemat kam', 'kam mein', 'sasta', 'saste mein', 'mol bhav', 'molbhav', 'chhoot', 'chhut',
    'कम करो', 'कम कर दो', 'कम कीजिए', 'कम करिए', 'थोड़ा कम', 'कुछ कम', 'दाम कम', 'कीमत कम', 'रेट कम', 'कम में', 'सस्ता', 'सस्ते में', 'डिस्काउंट', 'छूट', 'मोलभाव', 'मोल भाव',
  ],
  te: [
    'thagginchandi', 'tagginchandi', 'thagginchu', 'tagginchu', 'thakkuva cheyandi', 'takkuva cheyandi', 'thakkuva dhara', 'takkuva dhara', 'beram',
    'తగ్గించండి', 'తగ్గించు', 'తక్కువ చేయండి', 'తక్కువ ధర', 'తక్కువకు', 'డిస్కౌంట్', 'రాయితీ', 'బేరం',
  ],
  ta: [
    'kuraingal', 'kuraichu', 'koraichu', 'korachu', 'kuraikka', 'kammi pannunga', 'thallupadi', 'peram',
    'குறைக்கவும்', 'குறைத்து', 'குறைங்க', 'குறைச்சு', 'குறைந்த விலை', 'தள்ளுபடி', 'டிஸ்கவுண்ட்', 'பேரம்',
  ],
}

const CURRENCY_MARKERS = ['₹', 'rs', 'rs.', 'inr', 'rupee', 'rupees', 'rupaye', 'rupaiye', 'rupay', 'रुपये', 'रुपए', 'रुपया', 'रु', 'రూపాయలు', 'రూ', 'ரூபாய்', 'ரூ']
const MAGNITUDE_WORDS = ['k', 'lac', 'lacs', 'lakh', 'lakhs', 'cr', 'crore', 'crores', 'thousand', 'hazar', 'hazaar', 'हज़ार', 'हजार', 'लाख', 'करोड़', 'వేలు', 'వెయ్యి', 'లక్ష', 'లక్షలు', 'ஆயிரம்', 'லட்சம்']
const PERCENT_WORDS = ['percent', 'per cent', 'pct', 'pratishat', 'प्रतिशत', 'फीसदी', 'फ़ीसदी', 'శాతం', 'சதவீதம்', 'சதவிகிதம்']

/** NFKC → lowercase → Indic digits folded → punctuation (except ₹ % . ,) to spaces → whitespace collapsed. */
export function normaliseForClamp(s: string): string {
  return foldOutputDigits(s.normalize('NFKC'))
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}₹%.,\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// A word boundary that understands Indic scripts (letters AND combining marks are word characters).
const B = '(?<![\\p{L}\\p{M}\\p{N}])'
const E = '(?![\\p{L}\\p{M}\\p{N}])'

const CURRENCY_RE = new RegExp(`(?:₹\\s*\\d|${B}(?:${CURRENCY_MARKERS.filter((m) => m !== '₹').map(esc).join('|')})\\s*\\d|\\d[\\d,.]*\\s*(?:${CURRENCY_MARKERS.map(esc).join('|')})${E})`, 'u')
const MAGNITUDE_RE = new RegExp(`\\d[\\d,.]*\\s*(?:${MAGNITUDE_WORDS.map(esc).join('|')})${E}`, 'u')
/** Indian / western digit grouping (20,000 · 1,50,000) — an amount even without a currency marker. */
const GROUPED_RE = /\d{1,3}(?:,\d{2,3})+(?!\d)/u
const PERCENT_RE = new RegExp(`(?:\\d\\s*%|%\\s*\\d|${B}(?:${PERCENT_WORDS.map(esc).join('|')})${E})`, 'u')

export type ProviderMessageClampReason = 'amount' | 'percent' | 'counter_offer'

/** Whole-word hits of any locale's counter-offer phrases (every list, whatever the locale). */
export function counterOfferHits(text: string): string[] {
  const n = ` ${normaliseForClamp(text).replace(/[.,]/g, ' ').replace(/\s+/g, ' ')} `
  const hits: string[] = []
  for (const l of PROCUREMENT_LOCALES) {
    for (const p of COUNTER_OFFER_PHRASES[l]) {
      const q = normaliseForClamp(p).replace(/[.,]/g, ' ').replace(/\s+/g, ' ')
      if (new RegExp(`${B}${esc(q)}${E}`, 'u').test(n)) hits.push(p)
    }
  }
  return [...new Set(hits)]
}

/**
 * The ONE gate between a drafted provider message and a proposal: rejects a currency amount (₹ / Rs / rupees,
 * a magnitude word like 20k / 2 lakh, or a grouped number like 20,000), a percentage, or counter-offer phrasing.
 * A rejected draft is never proposed; the buyer is told the agent does not negotiate price and may message the
 * provider themselves. The buyer's own typed messages in the thread UI are untouched (as today).
 */
export function clampProviderMessage(body: string, _locale: ProcurementLocale | string = 'en'): { ok: true; body: string } | { ok: false; reasons: ProviderMessageClampReason[] } {
  void _locale // every locale's lists are checked; the hint is accepted for symmetry with the other clamps
  const n = normaliseForClamp(body)
  const reasons: ProviderMessageClampReason[] = []
  if (CURRENCY_RE.test(n) || MAGNITUDE_RE.test(n) || GROUPED_RE.test(n)) reasons.push('amount')
  if (PERCENT_RE.test(n)) reasons.push('percent')
  if (counterOfferHits(body).length) reasons.push('counter_offer')
  const trimmed = body.trim()
  if (!trimmed) return { ok: false, reasons: ['counter_offer'] }
  return reasons.length ? { ok: false, reasons } : { ok: true, body: trimmed.slice(0, 600) }
}

// ── the chat quote summary (pure; no model) ──────────────────────────────────

export interface ChatQuoteInput {
  id: string
  pricePaise: number
  deliveryDays: number | null
  status?: string
}

export interface ChatQuoteSummary {
  /** Exactly three lines: the quotes in display order, the facts (lowest total · fastest), what needs attention. */
  lines: [string, string, string]
  /** quote id → the letter the compare page shows beside it. */
  labels: Record<string, string>
  /** The live quotes in display order (the compare page's `ordering.ids`, filtered). */
  order: string[]
}

const ATTENTION: readonly CompareFlag[] = ['gst_not_included', 'transport_not_included', 'validity_short', 'validity_expired', 'advance_high']

const SUMMARY_COPY: Record<ProcurementLocale, {
  count: (n: number) => string
  days: (d: number) => string
  noDays: string
  more: (n: number) => string
  lowest: (l: string, p: string) => string
  fastest: (l: string, d: string) => string
  only: string
  attention: (items: string) => string
  none: string
  flag: Record<string, string>
}> = {
  en: {
    count: (n) => (n === 1 ? '1 quote' : `${n} quotes`),
    days: (d) => (d === 1 ? '1 day' : `${d} days`),
    noDays: 'days not stated',
    more: (n) => `+${n} more`,
    lowest: (l, p) => `Lowest total after GST: ${l} ${p}.`,
    fastest: (l, d) => `Fastest: ${l} (${d}).`,
    only: 'Only one quote so far.',
    attention: (items) => `Check before choosing: ${items}.`,
    none: 'Nothing needs special attention.',
    flag: { gst_not_included: 'GST extra', transport_not_included: 'transport extra', validity_short: 'valid only a few more days', validity_expired: 'validity has passed', advance_high: 'asks for a high advance' },
  },
  hi: {
    count: (n) => `${n} कोटेशन`,
    days: (d) => `${d} दिन`,
    noDays: 'दिन नहीं बताए',
    more: (n) => `+${n} और`,
    lowest: (l, p) => `GST जोड़कर सबसे कम कुल: ${l} ${p}।`,
    fastest: (l, d) => `सबसे तेज़: ${l} (${d})।`,
    only: 'अभी तक सिर्फ़ एक कोटेशन।',
    attention: (items) => `चुनने से पहले देखें: ${items}।`,
    none: 'कोई ख़ास बात ध्यान देने लायक नहीं।',
    flag: { gst_not_included: 'GST अलग', transport_not_included: 'ढुलाई अलग', validity_short: 'कुछ ही दिन और मान्य', validity_expired: 'मान्यता ख़त्म', advance_high: 'ज़्यादा एडवांस माँगा' },
  },
  te: {
    count: (n) => `${n} కొటేషన్లు`,
    days: (d) => `${d} రోజులు`,
    noDays: 'రోజులు చెప్పలేదు',
    more: (n) => `+${n} ఇంకా`,
    lowest: (l, p) => `GST కలిపి తక్కువ మొత్తం: ${l} ${p}.`,
    fastest: (l, d) => `వేగవంతమైనది: ${l} (${d}).`,
    only: 'ఇప్పటివరకు ఒకే కొటేషన్.',
    attention: (items) => `ఎంచుకునే ముందు చూడండి: ${items}.`,
    none: 'ప్రత్యేకంగా గమనించాల్సింది ఏమీ లేదు.',
    flag: { gst_not_included: 'GST అదనం', transport_not_included: 'రవాణా అదనం', validity_short: 'కొన్ని రోజులే చెల్లుతుంది', validity_expired: 'గడువు ముగిసింది', advance_high: 'ఎక్కువ అడ్వాన్స్ అడిగారు' },
  },
  ta: {
    count: (n) => `${n} விலைப்புள்ளிகள்`,
    days: (d) => `${d} நாட்கள்`,
    noDays: 'நாட்கள் குறிப்பிடவில்லை',
    more: (n) => `+${n} மேலும்`,
    lowest: (l, p) => `GST சேர்த்து குறைந்த மொத்தம்: ${l} ${p}.`,
    fastest: (l, d) => `விரைவானது: ${l} (${d}).`,
    only: 'இதுவரை ஒரே ஒரு விலைப்புள்ளி.',
    attention: (items) => `தேர்வு செய்யும் முன் பாருங்கள்: ${items}.`,
    none: 'தனியாக கவனிக்க வேண்டியது எதுவும் இல்லை.',
    flag: { gst_not_included: 'GST தனி', transport_not_included: 'போக்குவரத்து தனி', validity_short: 'சில நாட்களே செல்லும்', validity_expired: 'செல்லுபடி முடிந்தது', advance_high: 'அதிக முன்பணம் கேட்கிறது' },
  },
}

const LIVE_QUOTE_STATUSES = new Set(['submitted'])

/**
 * Three lines from the S1.2 deterministic comparison — no model, so every fact is the compare page's own. `quotes`
 * arrive in the compare page's LABEL order (the buyer's quote list, `loadBuyerQuotes`: the page letters them A, B, …
 * by that position whatever the display sort); `order` is the display order (`ordering.ids`). Declined / withdrawn /
 * expired quotes keep their letter but are left out of the lines.
 */
export function summariseQuotesForChat(
  results: readonly CompareQuoteResult[],
  quotes: readonly ChatQuoteInput[],
  locale: ProcurementLocale | string,
  opts: { order?: readonly string[] | null; maxListed?: number } = {},
): ChatQuoteSummary {
  const c = SUMMARY_COPY[toProcurementLocale(locale)]
  const labels: Record<string, string> = {}
  quotes.forEach((q, i) => (labels[q.id] = compareLabel(i)))
  const byId = new Map(quotes.map((q) => [q.id, q]))
  const resultById = new Map(results.map((r) => [r.id, r]))
  const live = quotes.filter((q) => !q.status || LIVE_QUOTE_STATUSES.has(q.status))
  const liveIds = new Set(live.map((q) => q.id))
  const ordered = [...(opts.order ?? []).filter((id) => liveIds.has(id)), ...live.map((q) => q.id).filter((id) => !(opts.order ?? []).includes(id))]
  const days = (d: number | null) => (d != null && d > 0 ? c.days(d) : c.noDays)
  const max = Math.max(1, opts.maxListed ?? 5)
  const listed = ordered.slice(0, max).map((id) => {
    const q = byId.get(id)!
    return `${labels[id]} ${formatRupees(q.pricePaise)} (${days(q.deliveryDays)})`
  })
  const line1 = ordered.length === 0 ? `${c.count(0)}.` : `${c.count(ordered.length)}: ${listed.join(' · ')}${ordered.length > max ? ` · ${c.more(ordered.length - max)}` : ''}`

  let line2: string
  if (ordered.length <= 1) line2 = c.only
  else {
    const facts: string[] = []
    const cheapest = ordered.find((id) => resultById.get(id)?.flags.includes('cheapest_after_normalization'))
    if (cheapest) facts.push(c.lowest(labels[cheapest]!, formatRupees(resultById.get(cheapest)!.normalizedTotalPaise)))
    const fastest = ordered.find((id) => resultById.get(id)?.flags.includes('fastest'))
    if (fastest) facts.push(c.fastest(labels[fastest]!, days(byId.get(fastest)!.deliveryDays)))
    line2 = facts.length ? facts.join(' ') : c.only
  }

  const items: string[] = []
  for (const id of ordered) {
    const flags = (resultById.get(id)?.flags ?? []).filter((f) => ATTENTION.includes(f))
    if (flags.length) items.push(`${labels[id]} — ${flags.slice(0, 2).map((f) => c.flag[f]).join(', ')}`)
    if (items.length >= 3) break
  }
  const line3 = items.length ? c.attention(items.join('; ')) : c.none
  return { lines: [line1, line2, line3], labels, order: ordered }
}

/** A stable key for a set of live quotes (a new summary goes out once per new set). */
export function quoteSetKey(ids: readonly string[]): string {
  return [...ids].sort().join(',')
}

// ── "go with B": is the letter really in the buyer's words? ─────────────────

/** Spoken / written letter names outside Latin (A–F; "जी" is left out on purpose — it is an honorific). */
const NATIVE_LETTERS: Record<string, readonly string[]> = {
  A: ['ए', 'ఏ', 'ஏ'],
  B: ['बी', 'బి', 'பி'],
  C: ['सी', 'సి', 'சி'],
  D: ['डी', 'డి', 'டி'],
  E: ['ई', 'ఈ', 'ஈ'],
  F: ['एफ', 'ఎఫ్', 'எஃப்'],
  G: [],
}

/**
 * True when `label` (A–G) literally appears in the buyer's text as a standalone letter — the code check that turns
 * the classifier's `choose_label` into a proposal. "a" (the article) counts only uppercase or after
 * option / quote / provider / number. Anything else → the clarifying label buttons.
 */
export function labelMentioned(text: string, label: string): boolean {
  if (!/^[A-G]$/.test(label)) return false
  const t = text.normalize('NFKC')
  const standalone = (re: RegExp) => re.test(t)
  if (label === 'A') {
    if (standalone(new RegExp(`${B}A${E}`, 'u'))) return true
    if (standalone(/(?:option|quote|provider|number|no\.?|letter|wala|vala)\s*a(?![\p{L}\p{M}\p{N}])/iu)) return true
  } else if (standalone(new RegExp(`${B}${label}${E}`, 'iu'))) return true
  return (NATIVE_LETTERS[label] ?? []).some((n) => new RegExp(`${B}${esc(n)}${E}`, 'u').test(t))
}

// ── button payloads (parsed by code, never by a model) ───────────────────────

export const PROCUREMENT_BUTTON_ACTIONS = ['ok', 'edit', 'no'] as const
export type ProcurementButtonAction = (typeof PROCUREMENT_BUTTON_ACTIONS)[number]

export type ProcurementButton =
  | { kind: 'decision'; action: ProcurementButtonAction; runId: string }
  | { kind: 'label'; sessionId: string; label: string }
  | { kind: 'session'; choice: 'new' | 'current'; messageId: string }

/** `pr:ok|edit|no:<runId>` · `pr:label:<sessionId>:<A-G>` · `pr:sess:new|cur:<messageId>` — the `pr:` namespace keeps them apart from Munshi / Support payloads. */
export function parseProcurementButton(payload: string | null | undefined): ProcurementButton | null {
  if (!payload) return null
  const p = payload.trim()
  let m = /^pr:(ok|edit|no):([0-9a-f-]{36})$/i.exec(p)
  if (m) return { kind: 'decision', action: m[1]!.toLowerCase() as ProcurementButtonAction, runId: m[2]!.toLowerCase() }
  m = /^pr:label:([0-9a-f-]{36}):([A-G])$/i.exec(p)
  if (m) return { kind: 'label', sessionId: m[1]!.toLowerCase(), label: m[2]!.toUpperCase() }
  m = /^pr:sess:(new|cur):([0-9a-f-]{36})$/i.exec(p)
  if (m) return { kind: 'session', choice: m[1]!.toLowerCase() === 'new' ? 'new' : 'current', messageId: m[2]!.toLowerCase() }
  return null
}

export function procurementButtonId(b: ProcurementButton): string {
  if (b.kind === 'decision') return `pr:${b.action}:${b.runId}`
  if (b.kind === 'label') return `pr:label:${b.sessionId}:${b.label}`
  return `pr:sess:${b.choice === 'new' ? 'new' : 'cur'}:${b.messageId}`
}

// ── the deep link ("go with B") ──────────────────────────────────────────────

/**
 * The ONLY effect of an approved `choose_quote`: the buyer's own RFQ page with that quote preselected. The decision id
 * binds the link — the page opens its ordinary confirm sheet only when the ai_decisions row (tool choose_quote,
 * decided by this buyer, final.quote_id = pay) matches; the checkout call is the page's existing one.
 */
export function procurementCheckoutPath(rfqId: string, quoteId: string, decisionId: string): string {
  return `/app/rfq/${rfqId}?pay=${encodeURIComponent(quoteId)}&d=${encodeURIComponent(decisionId)}`
}

export const chooseQuotePayloadSchema = z
  .object({
    rfq_id: uuidSchema,
    quote_id: uuidSchema,
    label: quoteLabel,
    price_paise: z.number().int().positive(),
  })
  .strict()
export type ChooseQuotePayload = z.infer<typeof chooseQuotePayloadSchema>

// ── settings defaults (the registry holds the switches; these are the clamps' bounds) ──

export const PROCUREMENT_DEFAULTS = {
  chaseHours: 24,
  sessionTtlDays: 7,
  maxProposalsPerDay: 30,
  budgetRunPaise: 1500,
} as const

/** Sessions whose request the watcher still follows. */
export const PROCUREMENT_WATCHED_STATES = ['quality', 'live', 'quotes_in', 'chosen'] as const
