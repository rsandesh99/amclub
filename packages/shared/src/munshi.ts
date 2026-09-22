/**
 * S2.2 — Digital Munshi v1: the provider's sales clerk (BUILD_PROMPTS S2.2).
 *
 * The contract for a proactive agent that reads a provider's newly matched
 * RFQs and drafts a quote, one clarifying question, or a skip. Three laws are
 * code here, never a prompt:
 *
 *   1. No price history, no price. A `quote` draft needs ≥ 1 price-book row in
 *      the RFQ's category and its price must lie inside `munshiPriceBand()` —
 *      the [min, max] of the basis rows widened by `tolerance_bps`. Anything the
 *      model proposes outside the band becomes an `ask` (fixed per-locale
 *      question), never a silently adjusted number (`clampMunshiDraft`).
 *   2. Voice never confirms through a model. `isUnambiguousYes()` is an exact
 *      match after normalisation against `MUNSHI_YES_PHRASES`; the
 *      `approval_intent` classifier can only re-ask or treat the note as edit
 *      instructions.
 *   3. Every submit is the ordinary route after the provider's tap; the draft is
 *      a proposal (`munshi_drafts.status = 'proposed'`) until then.
 *
 * Money in paise. Locales en / hi / te / ta (the WhatsApp copy lives here, as
 * `onboarding-copy.ts` does for S1.6, because the runtime has no next-intl).
 */
import { z } from 'zod'
import { uuidSchema } from './schemas/index'

// ── scopes + vocabulary ──────────────────────────────────────────────────────

/** The provider grant Munshi runs under — every tool it may propose (⊆ toolsForPersona('provider')). */
export const MUNSHI_SCOPES = [
  'extract_requirements',
  'read_price_book',
  'draft_quote',
  'submit_quote',
  'ask_clarification',
  'reply_thread',
  'list_deadlines',
] as const
export type MunshiScope = (typeof MUNSHI_SCOPES)[number]

export const MUNSHI_LOCALES = ['en', 'hi', 'te', 'ta'] as const
export type MunshiLocale = (typeof MUNSHI_LOCALES)[number]
export function toMunshiLocale(l: string | null | undefined): MunshiLocale {
  const base = (l ?? 'en').toLowerCase().split(/[-_]/)[0] ?? 'en'
  return (MUNSHI_LOCALES as readonly string[]).includes(base) ? (base as MunshiLocale) : 'en'
}

export const MUNSHI_DRAFT_KINDS = ['quote', 'ask', 'skip', 'reply'] as const
export type MunshiDraftKind = (typeof MUNSHI_DRAFT_KINDS)[number]
export const MUNSHI_DRAFT_STATUSES = ['proposed', 'approved', 'edited', 'skipped', 'expired', 'failed'] as const
export type MunshiDraftStatus = (typeof MUNSHI_DRAFT_STATUSES)[number]
export const MUNSHI_SKIP_REASONS = [
  'no_price_history',
  'out_of_capability',
  'goods_rfq',
  'already_quoted',
  'window_lapsed',
  'unclear_after_question',
  'other',
] as const
export type MunshiSkipReason = (typeof MUNSHI_SKIP_REASONS)[number]

/** A proposed draft expires (status `expired`, run cancelled) this long after it was proposed. */
export const MUNSHI_DRAFT_TTL_HOURS = 24
/** Child runs per provider per scan — the rest wait for the next scan. */
export const MUNSHI_MAX_DRAFTS_PER_SCAN = 5
/** Basis rows shown to the model and stored on the draft (accepted first, then newest). */
export const MUNSHI_MAX_BASIS_ROWS = 5
/** Consent text version snapshotted on the grant when a provider enables Munshi. */
export const MUNSHI_CONSENT_TEXT_VERSION = 'munshi-v1-2026-09-22'

// ── the draft contract ───────────────────────────────────────────────────────

const isoTimestamp = z.string().datetime({ offset: true })

export const munshiQuoteSchema = z
  .object({
    price_paise: z.number().int().positive(),
    delivery_days: z.number().int().min(1).max(365),
    scope: z.string().min(20).max(2000),
    gst_included: z.boolean().nullable(),
    transport_included: z.boolean().nullable(),
    valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    advance_percent: z.number().int().min(0).max(100).nullable(),
  })
  .strict()
export type MunshiQuote = z.infer<typeof munshiQuoteSchema>

export const munshiBasisRowSchema = z
  .object({
    price_book_id: uuidSchema,
    price_paise: z.number().int().positive(),
    confirmed_at: isoTimestamp,
    accepted: z.boolean(),
  })
  .strict()
export type MunshiBasisRow = z.infer<typeof munshiBasisRowSchema>

/**
 * The bare draft. agent-core wraps it with `customerFacingText` (scope,
 * question, rationale — contact / payment / urls) under the same name; this is
 * what `munshi_drafts.draft` stores and what every client renders.
 */
export const munshiDraftSchema = z
  .object({
    action: z.enum(['quote', 'ask', 'skip']),
    quote: munshiQuoteSchema.nullable(),
    basis: z.array(munshiBasisRowSchema).max(MUNSHI_MAX_BASIS_ROWS),
    question: z.string().min(10).max(500).nullable(),
    skip_reason: z.enum(MUNSHI_SKIP_REASONS).nullable(),
    rationale: z.array(z.string().max(160)).min(1).max(4),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict()
export type MunshiDraft = z.infer<typeof munshiDraftSchema>

// ── price basis + band (code, never a prompt) ────────────────────────────────

/** A `provider_price_book` row as the runtime reads it through `GET /partner/price-book`. */
export interface MunshiPriceBookRow {
  id: string
  price_paise: number
  confirmed_at: string
  accepted: boolean
  delivery_days?: number | null
  unit?: string | null
  specialization?: string | null
}

/** Accepted rows first, then newest; at most `max`. */
export function selectBasisRows(rows: readonly MunshiPriceBookRow[], max = MUNSHI_MAX_BASIS_ROWS): MunshiPriceBookRow[] {
  return [...rows]
    .filter((r) => Number.isInteger(r.price_paise) && r.price_paise > 0)
    .sort((a, b) => Number(b.accepted) - Number(a.accepted) || b.confirmed_at.localeCompare(a.confirmed_at))
    .slice(0, max)
}

export function toBasis(rows: readonly MunshiPriceBookRow[]): MunshiBasisRow[] {
  return rows.map((r) => ({ price_book_id: r.id, price_paise: r.price_paise, confirmed_at: r.confirmed_at, accepted: r.accepted }))
}

export interface MunshiPriceBand {
  min_paise: number
  max_paise: number
}

/** [min, max] of the basis rows widened by `toleranceBps` (clamped 0..10000). null without rows. */
export function munshiPriceBand(rows: readonly MunshiPriceBookRow[], toleranceBps: number): MunshiPriceBand | null {
  const prices = rows.map((r) => r.price_paise).filter((p) => Number.isInteger(p) && p > 0)
  if (!prices.length) return null
  const t = Math.max(0, Math.min(10_000, Math.trunc(toleranceBps)))
  const lo = Math.min(...prices)
  const hi = Math.max(...prices)
  return {
    min_paise: Math.max(1, Math.floor((lo * (10_000 - t)) / 10_000)),
    max_paise: Math.ceil((hi * (10_000 + t)) / 10_000),
  }
}

export function priceInBand(pricePaise: number, band: MunshiPriceBand): boolean {
  return pricePaise >= band.min_paise && pricePaise <= band.max_paise
}

// ── fixed copy (per locale) ──────────────────────────────────────────────────

/** The `ask` question code substitutes when a proposed price leaves the band or a quote arrives without one. */
export const MUNSHI_BAND_QUESTION: Record<MunshiLocale, string> = {
  en: 'Could you share your budget range and a little more detail on the scope, so I can quote accurately?',
  hi: 'कृपया अपना बजट और काम का दायरा थोड़ा और बताएँ, ताकि मैं सही कोटेशन दे सकूँ।',
  te: 'దయచేసి మీ బడ్జెట్ పరిధి మరియు పని వివరాలు కొంచెం ఎక్కువ చెప్పండి, సరైన కొటేషన్ ఇవ్వగలను.',
  ta: 'தயவுசெய்து உங்கள் பட்ஜெட் மற்றும் வேலையின் விவரங்களை இன்னும் கொஞ்சம் கூறுங்கள், சரியான விலைப்புள்ளி தர முடியும்.',
}

export const MUNSHI_CLAMP_NOTES: Record<'band' | 'no_basis' | 'no_quote' | 'goods' | 'already_quoted' | 'window_lapsed', Record<MunshiLocale, string>> = {
  band: {
    en: 'The proposed price was outside your usual range, so Munshi asks the buyer instead.',
    hi: 'प्रस्तावित कीमत आपकी सामान्य सीमा से बाहर थी, इसलिए मुंशी खरीदार से पूछ रहा है।',
    te: 'ప్రతిపాదిత ధర మీ సాధారణ పరిధికి బయట ఉంది, కాబట్టి మున్షీ కొనుగోలుదారుని అడుగుతోంది.',
    ta: 'முன்மொழியப்பட்ட விலை உங்கள் வழக்கமான வரம்புக்கு வெளியே இருந்தது, எனவே முன்ஷி வாங்குபவரிடம் கேட்கிறது.',
  },
  no_basis: {
    en: 'No price history in this category yet — add one price to your price book to get quote drafts.',
    hi: 'इस श्रेणी में अभी कोई कीमत इतिहास नहीं है — कोटेशन ड्राफ्ट पाने के लिए अपनी प्राइस बुक में एक कीमत जोड़ें।',
    te: 'ఈ వర్గంలో ఇంకా ధర చరిత్ర లేదు — కొటేషన్ డ్రాఫ్ట్‌ల కోసం మీ ప్రైస్ బుక్‌లో ఒక ధర జోడించండి.',
    ta: 'இந்த பிரிவில் இன்னும் விலை வரலாறு இல்லை — விலைப்புள்ளி வரைவுகளுக்கு உங்கள் விலைப் புத்தகத்தில் ஒரு விலையைச் சேர்க்கவும்.',
  },
  no_quote: {
    en: 'Munshi could not settle on a price, so it asks the buyer instead.',
    hi: 'मुंशी कीमत तय नहीं कर सका, इसलिए खरीदार से पूछ रहा है।',
    te: 'మున్షీ ధర నిర్ణయించలేకపోయింది, కాబట్టి కొనుగోలుదారుని అడుగుతోంది.',
    ta: 'முன்ஷி விலையை முடிவு செய்ய முடியவில்லை, எனவே வாங்குபவரிடம் கேட்கிறது.',
  },
  goods: {
    en: 'This is a goods request; Munshi drafts service quotes only.',
    hi: 'यह सामान की माँग है; मुंशी केवल सेवा कोटेशन बनाता है।',
    te: 'ఇది వస్తువుల అభ్యర్థన; మున్షీ సేవా కొటేషన్‌లు మాత్రమే రూపొందిస్తుంది.',
    ta: 'இது பொருட்களுக்கான கோரிக்கை; முன்ஷி சேவை விலைப்புள்ளிகளை மட்டுமே வரைகிறது.',
  },
  already_quoted: {
    en: 'You have already quoted on this request.',
    hi: 'आप इस माँग पर पहले ही कोटेशन दे चुके हैं।',
    te: 'మీరు ఈ అభ్యర్థనకు ఇప్పటికే కొటేషన్ ఇచ్చారు.',
    ta: 'இந்த கோரிக்கைக்கு நீங்கள் ஏற்கனவே விலைப்புள்ளி அளித்துவிட்டீர்கள்.',
  },
  window_lapsed: {
    en: 'The quote window for this request has lapsed.',
    hi: 'इस माँग की कोटेशन अवधि समाप्त हो गई है।',
    te: 'ఈ అభ్యర్థనకు కొటేషన్ గడువు ముగిసింది.',
    ta: 'இந்த கோரிக்கைக்கான விலைப்புள்ளி காலம் முடிந்துவிட்டது.',
  },
}

// ── the clamp ────────────────────────────────────────────────────────────────

export interface MunshiClampContext {
  /** The provider's price-book rows for the RFQ's category (the runtime passes all; the clamp selects). */
  basisRows: readonly MunshiPriceBookRow[]
  toleranceBps: number
  rfqKind: 'services' | 'goods'
  alreadyQuoted: boolean
  windowLapsed: boolean
  locale: MunshiLocale
}

function withNote(rationale: readonly string[], note: string): string[] {
  const kept = rationale.filter((r) => r.trim().length > 0).slice(0, 3)
  return [...kept, note].map((r) => r.slice(0, 160))
}

function skipDraft(d: MunshiDraft, reason: MunshiSkipReason, note: string | null): MunshiDraft {
  return {
    action: 'skip',
    quote: null,
    basis: [],
    question: null,
    skip_reason: reason,
    rationale: note ? withNote(d.rationale, note) : (d.rationale.length ? d.rationale : ['skipped']),
    confidence: d.confidence,
  }
}

/**
 * The only path from a model draft to a stored draft. Deterministic; the
 * outcome depends on the context, never on what the model claimed:
 *   goods → skip goods_rfq · already quoted → skip · window lapsed → skip ·
 *   quote without basis rows → skip no_price_history · quote with no quote body
 *   or a price outside the band → ask (fixed question) · ask without a
 *   question → fixed question · skip without a reason → other.
 * The stored `basis` is always the code-selected rows, never the model's list.
 */
export function clampMunshiDraft(input: MunshiDraft, ctx: MunshiClampContext): MunshiDraft {
  const d = munshiDraftSchema.parse(input)
  const notes = (k: keyof typeof MUNSHI_CLAMP_NOTES) => MUNSHI_CLAMP_NOTES[k][ctx.locale]
  if (ctx.rfqKind === 'goods') return skipDraft(d, 'goods_rfq', notes('goods'))
  if (ctx.alreadyQuoted) return skipDraft(d, 'already_quoted', notes('already_quoted'))
  if (ctx.windowLapsed) return skipDraft(d, 'window_lapsed', notes('window_lapsed'))

  const selected = selectBasisRows(ctx.basisRows)
  const band = munshiPriceBand(selected, ctx.toleranceBps)
  const basis = toBasis(selected)
  const fixedQuestion = MUNSHI_BAND_QUESTION[ctx.locale]

  if (d.action === 'quote') {
    if (!band) return skipDraft(d, 'no_price_history', notes('no_basis'))
    if (!d.quote) {
      return { action: 'ask', quote: null, basis, question: fixedQuestion, skip_reason: null, rationale: withNote(d.rationale, notes('no_quote')), confidence: 'low' }
    }
    if (!priceInBand(d.quote.price_paise, band)) {
      return { action: 'ask', quote: null, basis, question: fixedQuestion, skip_reason: null, rationale: withNote(d.rationale, notes('band')), confidence: 'low' }
    }
    return { action: 'quote', quote: d.quote, basis, question: null, skip_reason: null, rationale: d.rationale, confidence: d.confidence }
  }
  if (d.action === 'ask') {
    const q = d.question && d.question.trim().length >= 10 ? d.question.trim() : fixedQuestion
    return { action: 'ask', quote: null, basis: [], question: q, skip_reason: null, rationale: d.rationale, confidence: d.confidence }
  }
  return { action: 'skip', quote: null, basis: [], question: null, skip_reason: d.skip_reason ?? 'other', rationale: d.rationale, confidence: d.confidence }
}

// ── approval: the allow-list (code) + the classifier (never approves) ────────

export const approvalIntentSchema = z
  .object({
    intent: z.enum(['approve', 'reject', 'edit', 'unclear']),
    edit_instructions: z.string().max(500).nullable(),
  })
  .strict()
export type ApprovalIntent = z.infer<typeof approvalIntentSchema>

/**
 * Unambiguous "yes" phrases per locale, ≤ 6 words each, matched EXACTLY after
 * `normaliseUtterance`. Latin transliterations sit beside the native script
 * because the STT vendor may return either. The `en` list is checked for every
 * locale (the vendor may translate to English). Bare "ok" / "sari" / "theek hai"
 * are deliberately absent — they acknowledge, they do not approve.
 */
export const MUNSHI_YES_PHRASES: Record<MunshiLocale, readonly string[]> = {
  en: [
    'yes', 'yes send', 'yes send it', 'yes please send', 'yes go ahead', 'yes approve', 'yes approved', 'yes confirm', 'yes confirmed',
    'ok send', 'ok send it', 'okay send', 'okay send it', 'ok go ahead', 'ok approve', 'ok approved', 'okay approve',
    'send it', 'send the quote', 'go ahead', 'go ahead and send', 'approve', 'approved', 'approve it', 'confirm', 'confirmed', 'confirm and send',
    'yes send the quote', 'please send', 'please send it',
  ],
  hi: [
    'haan', 'ha', 'haan bhej do', 'ha bhej do', 'haan bhejo', 'bhej do', 'bhejo', 'bhej dijiye', 'haan bhej dijiye',
    'theek hai bhej do', 'thik hai bhej do', 'ok bhej do', 'okay bhej do', 'haan theek hai bhej do', 'haan sahi hai bhej do', 'haan approve',
    'हाँ', 'हां', 'हाँ भेज दो', 'हां भेज दो', 'हाँ भेजो', 'हां भेजो', 'भेज दो', 'भेजो', 'भेज दीजिए', 'ठीक है भेज दो', 'हाँ ठीक है भेज दो', 'हां ठीक है भेज दो',
  ],
  te: [
    'avunu', 'avunu pampandi', 'avunu pampu', 'pampandi', 'pampu', 'sare pampandi', 'sare pampu', 'ok pampandi', 'okay pampandi', 'avunu sare pampandi',
    'అవును', 'అవును పంపండి', 'అవును పంపు', 'పంపండి', 'పంపు', 'సరే పంపండి', 'సరే పంపు', 'అవును సరే పంపండి',
  ],
  ta: [
    'aama', 'aamaa', 'aamam', 'aama anuppu', 'aama anuppungal', 'sari anuppu', 'seri anuppu', 'sari anuppungal', 'seri anuppungal', 'anuppu', 'anuppungal', 'ok anuppu', 'okay anuppu',
    'ஆமா', 'ஆமாம்', 'ஆமா அனுப்பு', 'ஆமா அனுப்புங்கள்', 'சரி அனுப்பு', 'சரி அனுப்புங்கள்', 'அனுப்பு', 'அனுப்புங்கள்',
  ],
}

/** NFKC → lowercase → punctuation, symbols and emoji removed → whitespace collapsed. */
export function normaliseUtterance(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const YES_MAX_WORDS = 6

/**
 * True only when the normalised transcript EQUALS an allow-listed phrase for the
 * locale (or the English list). "yes but change the price" is not a yes.
 */
export function isUnambiguousYes(transcript: string, locale: MunshiLocale | string): boolean {
  const n = normaliseUtterance(transcript)
  if (!n || n.split(' ').length > YES_MAX_WORDS) return false
  const loc = toMunshiLocale(locale)
  const lists = loc === 'en' ? [MUNSHI_YES_PHRASES.en] : [MUNSHI_YES_PHRASES[loc], MUNSHI_YES_PHRASES.en]
  return lists.some((list) => list.some((p) => normaliseUtterance(p) === n))
}

// ── thread replies ───────────────────────────────────────────────────────────

export const threadReplyDraftSchema = z
  .object({
    body: z.string().min(1).max(1000),
    needs_provider_input: z.boolean(),
    rationale: z.string().max(160),
  })
  .strict()
export type ThreadReplyDraft = z.infer<typeof threadReplyDraftSchema>

// ── rendering (WhatsApp summary; pure) ───────────────────────────────────────

export function formatRupees(paise: number): string {
  const rupees = Math.round(paise) / 100
  const whole = Number.isInteger(rupees)
  return '₹' + rupees.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: whole ? 0 : 2 })
}

const RENDER_COPY: Record<MunshiLocale, { quote: string; ask: string; skip: string; days: string; basis: (n: number, a: string, b: string) => string; noBasis: string; tap: string; reply: string }> = {
  en: { quote: 'Munshi drafted a quote', ask: 'Munshi suggests one question', skip: 'Munshi suggests skipping', days: 'days', basis: (n, a, b) => `Based on ${n} of your quotes: ${a}–${b}`, noBasis: 'No price history in this category', tap: 'Tap Approve to send, Edit to change, Skip to ignore.', reply: 'Munshi drafted a reply to the buyer' },
  hi: { quote: 'मुंशी ने कोटेशन ड्राफ्ट किया', ask: 'मुंशी एक सवाल पूछने की सलाह देता है', skip: 'मुंशी छोड़ने की सलाह देता है', days: 'दिन', basis: (n, a, b) => `आपके ${n} कोटेशन के आधार पर: ${a}–${b}`, noBasis: 'इस श्रेणी में कोई कीमत इतिहास नहीं', tap: 'भेजने के लिए Approve, बदलने के लिए Edit, छोड़ने के लिए Skip दबाएँ।', reply: 'मुंशी ने खरीदार को जवाब ड्राफ्ट किया' },
  te: { quote: 'మున్షీ కొటేషన్ డ్రాఫ్ట్ చేసింది', ask: 'మున్షీ ఒక ప్రశ్న అడగమని సూచిస్తోంది', skip: 'మున్షీ దాటవేయమని సూచిస్తోంది', days: 'రోజులు', basis: (n, a, b) => `మీ ${n} కొటేషన్ల ఆధారంగా: ${a}–${b}`, noBasis: 'ఈ వర్గంలో ధర చరిత్ర లేదు', tap: 'పంపడానికి Approve, మార్చడానికి Edit, వదిలేయడానికి Skip నొక్కండి.', reply: 'మున్షీ కొనుగోలుదారుకు జవాబు డ్రాఫ్ట్ చేసింది' },
  ta: { quote: 'முன்ஷி விலைப்புள்ளி வரைந்தது', ask: 'முன்ஷி ஒரு கேள்வி கேட்கப் பரிந்துரைக்கிறது', skip: 'முன்ஷி தவிர்க்கப் பரிந்துரைக்கிறது', days: 'நாட்கள்', basis: (n, a, b) => `உங்கள் ${n} விலைப்புள்ளிகளின் அடிப்படையில்: ${a}–${b}`, noBasis: 'இந்த பிரிவில் விலை வரலாறு இல்லை', tap: 'அனுப்ப Approve, மாற்ற Edit, தவிர்க்க Skip அழுத்தவும்.', reply: 'முன்ஷி வாங்குபவருக்கு பதில் வரைந்தது' },
}

export function munshiBasisLine(basis: readonly MunshiBasisRow[], locale: MunshiLocale): string {
  const c = RENDER_COPY[locale]
  if (!basis.length) return c.noBasis
  const prices = basis.map((b) => b.price_paise)
  return c.basis(basis.length, formatRupees(Math.min(...prices)), formatRupees(Math.max(...prices)))
}

/** The WhatsApp / notification summary of a draft — pure, no ids, no contact details, ≤ ~600 chars. */
export function renderMunshiDraft(draft: MunshiDraft, locale: MunshiLocale, rfqTitle: string): string {
  const c = RENDER_COPY[locale]
  const title = rfqTitle.trim().slice(0, 120)
  const lines: string[] = []
  if (draft.action === 'quote' && draft.quote) {
    lines.push(`${c.quote} — ${title}`)
    lines.push(`${formatRupees(draft.quote.price_paise)} · ${draft.quote.delivery_days} ${c.days}`)
    lines.push(munshiBasisLine(draft.basis, locale))
    lines.push(draft.quote.scope.slice(0, 240))
  } else if (draft.action === 'ask') {
    lines.push(`${c.ask} — ${title}`)
    lines.push(draft.question ?? '')
    if (draft.basis.length) lines.push(munshiBasisLine(draft.basis, locale))
  } else {
    lines.push(`${c.skip} — ${title}`)
  }
  for (const r of draft.rationale.slice(0, 2)) lines.push(`• ${r}`)
  if (draft.action !== 'skip') lines.push(c.tap)
  return lines.filter((l) => l.length > 0).join('\n')
}

export function renderMunshiReply(draft: ThreadReplyDraft, locale: MunshiLocale, rfqTitle: string): string {
  const c = RENDER_COPY[locale]
  return [`${c.reply} — ${rfqTitle.trim().slice(0, 120)}`, draft.body.slice(0, 600), c.tap].join('\n')
}

/** WhatsApp button payloads: `<action>:<runId>` — parsed by the dispatcher, never by a model. */
export const MUNSHI_BUTTON_ACTIONS = ['approve', 'edit', 'skip'] as const
export type MunshiButtonAction = (typeof MUNSHI_BUTTON_ACTIONS)[number]
export function parseMunshiButton(payload: string | null | undefined): { action: MunshiButtonAction; runId: string } | null {
  if (!payload) return null
  const m = /^(approve|edit|skip):([0-9a-f-]{36})$/i.exec(payload.trim())
  if (!m) return null
  return { action: m[1]!.toLowerCase() as MunshiButtonAction, runId: m[2]!.toLowerCase() }
}
