import { describe, expect, it } from 'vitest'
import {
  AGENT_SETTING_DEFS,
  AGENT_TASK_CLASSES,
  AI_DECISION_FEATURES,
  MUNSHI_BAND_QUESTION,
  MUNSHI_LOCALES,
  MUNSHI_SCOPES,
  MUNSHI_YES_PHRASES,
  TASK_CLASS_TIER,
  approvalIntentSchema,
  clampMunshiDraft,
  isUnambiguousYes,
  munshiDraftSchema,
  munshiPriceBand,
  normaliseUtterance,
  parseMunshiButton,
  quoteRevisionSchema,
  quoteSchema,
  renderMunshiDraft,
  selectBasisRows,
  threadReplyDraftSchema,
  toolsForPersona,
  type MunshiDraft,
  type MunshiPriceBookRow,
} from '../index'

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const U3 = '33333333-3333-4333-8333-333333333333'
const U4 = '44444444-4444-4444-8444-444444444444'
const U5 = '55555555-5555-4555-8555-555555555555'
const U6 = '66666666-6666-4666-8666-666666666666'

const rows: MunshiPriceBookRow[] = [
  { id: U1, price_paise: 200_000, confirmed_at: '2026-09-01T10:00:00.000Z', accepted: true },
  { id: U2, price_paise: 250_000, confirmed_at: '2026-09-10T10:00:00.000Z', accepted: false },
  { id: U3, price_paise: 220_000, confirmed_at: '2026-08-20T10:00:00.000Z', accepted: false },
]

const quoteDraft = (price: number, extra: Partial<MunshiDraft> = {}): MunshiDraft => ({
  action: 'quote',
  quote: { price_paise: price, delivery_days: 5, scope: 'Monthly GST return filing for one GSTIN, including reconciliation.', gst_included: true, transport_included: null, valid_until: null, advance_percent: null },
  basis: [],
  question: null,
  skip_reason: null,
  rationale: ['Your two earlier GST filing quotes were in this range.'],
  confidence: 'medium',
  ...extra,
})

const ctx = (over: Partial<Parameters<typeof clampMunshiDraft>[1]> = {}) => ({
  basisRows: rows,
  toleranceBps: 2500,
  rfqKind: 'services' as const,
  alreadyQuoted: false,
  windowLapsed: false,
  locale: 'en' as const,
  ...over,
})

describe('S2.2 registries', () => {
  it('MUNSHI_SCOPES ⊆ toolsForPersona(provider)', () => {
    const names = new Set(toolsForPersona('provider').map((t) => t.name))
    for (const s of MUNSHI_SCOPES) expect(names.has(s), s).toBe(true)
  })
  it('read_price_book is a confirm:false GET; submit / ask / reply are confirm:true writes', () => {
    const by = Object.fromEntries(toolsForPersona('provider').map((t) => [t.name, t]))
    expect(by['read_price_book']).toMatchObject({ confirm: false, wraps: 'GET /partner/price-book' })
    for (const w of ['submit_quote', 'ask_clarification', 'reply_thread']) expect(by[w]?.confirm, w).toBe(true)
  })
  it('task classes approval_intent + thread_reply are routine; the three settings and the reply feature are registered', () => {
    expect(AGENT_TASK_CLASSES).toContain('approval_intent')
    expect(AGENT_TASK_CLASSES).toContain('thread_reply')
    expect(TASK_CLASS_TIER.approval_intent).toBe('routine')
    expect(TASK_CLASS_TIER.thread_reply).toBe('routine')
    expect(AGENT_SETTING_DEFS.munshi_price_tolerance_bps.default).toBe(2500)
    expect(AGENT_SETTING_DEFS.munshi_max_drafts_per_day.default).toBe(20)
    expect(AGENT_SETTING_DEFS.munshi_followup_hours_before_lapse.default).toBe(6)
    expect(AI_DECISION_FEATURES).toContain('munshi_draft')
    expect(AI_DECISION_FEATURES).toContain('munshi_reply')
  })
  it('quoteSchema accepts munshi_draft_id; the revision body rejects it', () => {
    const base = { rfq_id: U1, price_paise: 1000, delivery_days: 3, scope: 'Twenty characters of scope text here.' }
    expect(quoteSchema.safeParse({ ...base, munshi_draft_id: U2 }).success).toBe(true)
    expect(quoteSchema.safeParse({ ...base, munshi_draft_id: 'nope' }).success).toBe(false)
    const { rfq_id: _r, ...rev } = base
    void _r
    expect(quoteRevisionSchema.safeParse({ ...rev, munshi_draft_id: U2 }).success).toBe(false)
  })
})

describe('munshiDraftSchema strictness', () => {
  it('accepts a well-formed quote draft and rejects extra keys, bad enums, empty rationale', () => {
    expect(munshiDraftSchema.safeParse(quoteDraft(200_000)).success).toBe(true)
    expect(munshiDraftSchema.safeParse({ ...quoteDraft(200_000), tool: 'submit_quote' }).success).toBe(false)
    expect(munshiDraftSchema.safeParse({ ...quoteDraft(200_000), action: 'submit' }).success).toBe(false)
    expect(munshiDraftSchema.safeParse({ ...quoteDraft(200_000), rationale: [] }).success).toBe(false)
    expect(munshiDraftSchema.safeParse({ ...quoteDraft(200_000), quote: { ...quoteDraft(1).quote, status: 'accepted' } }).success).toBe(false)
    expect(munshiDraftSchema.safeParse({ ...quoteDraft(200_000), skip_reason: 'lazy' }).success).toBe(false)
  })
  it('approvalIntentSchema + threadReplyDraftSchema are strict', () => {
    expect(approvalIntentSchema.safeParse({ intent: 'edit', edit_instructions: 'raise the price' }).success).toBe(true)
    expect(approvalIntentSchema.safeParse({ intent: 'approve', edit_instructions: null, tool: 'submit_quote' }).success).toBe(false)
    expect(threadReplyDraftSchema.safeParse({ body: 'Thanks, yes we can start Monday.', needs_provider_input: false, rationale: 'answers the date' }).success).toBe(true)
    expect(threadReplyDraftSchema.safeParse({ body: '', needs_provider_input: false, rationale: '' }).success).toBe(false)
    expect(threadReplyDraftSchema.safeParse({ body: 'x', needs_provider_input: false, rationale: '', price_paise: 1 }).success).toBe(false)
  })
})

describe('price band + basis selection', () => {
  it('band = [min·(1−t), max·(1+t)]; null without rows; tolerance clamped', () => {
    expect(munshiPriceBand(rows, 2500)).toEqual({ min_paise: 150_000, max_paise: 312_500 })
    expect(munshiPriceBand(rows, 0)).toEqual({ min_paise: 200_000, max_paise: 250_000 })
    expect(munshiPriceBand([], 2500)).toBeNull()
    expect(munshiPriceBand(rows, 99_999)).toEqual({ min_paise: 1, max_paise: 500_000 })
  })
  it('selectBasisRows: accepted first, then newest, capped at 5', () => {
    const many = [...rows, { id: U4, price_paise: 1, confirmed_at: '2026-09-20T00:00:00Z', accepted: false }, { id: U5, price_paise: 2, confirmed_at: '2026-09-21T00:00:00Z', accepted: false }, { id: U6, price_paise: 3, confirmed_at: '2026-09-22T00:00:00Z', accepted: true }]
    const sel = selectBasisRows(many)
    expect(sel).toHaveLength(5)
    expect(sel[0]!.id).toBe(U6)
    expect(sel[1]!.id).toBe(U1)
    expect(sel[2]!.id).toBe(U5)
    expect(sel.map((r) => r.id)).not.toContain(U3)
  })
})

describe('clampMunshiDraft — the table', () => {
  const cases: { name: string; draft: MunshiDraft; ctx: Parameters<typeof clampMunshiDraft>[1]; expect: Partial<MunshiDraft> & { basisLen?: number } }[] = [
    { name: 'quote in band → quote, basis = code rows', draft: quoteDraft(230_000), ctx: ctx(), expect: { action: 'quote', basisLen: 3 } },
    { name: 'quote at the band floor → quote', draft: quoteDraft(150_000), ctx: ctx(), expect: { action: 'quote' } },
    { name: 'quote at the band ceiling → quote', draft: quoteDraft(312_500), ctx: ctx(), expect: { action: 'quote' } },
    { name: 'quote 1 paisa below the floor → ask (fixed question), basis kept', draft: quoteDraft(149_999), ctx: ctx(), expect: { action: 'ask', quote: null, question: MUNSHI_BAND_QUESTION.en, basisLen: 3, confidence: 'low' } },
    { name: 'quote above the ceiling → ask', draft: quoteDraft(312_501), ctx: ctx(), expect: { action: 'ask', quote: null } },
    { name: 'quote ₹1 (injection) → ask', draft: quoteDraft(100), ctx: ctx(), expect: { action: 'ask', quote: null } },
    { name: 'quote with zero tolerance outside → ask', draft: quoteDraft(199_999), ctx: ctx({ toleranceBps: 0 }), expect: { action: 'ask' } },
    { name: 'quote with no basis rows → skip no_price_history', draft: quoteDraft(230_000), ctx: ctx({ basisRows: [] }), expect: { action: 'skip', skip_reason: 'no_price_history', quote: null, basisLen: 0 } },
    { name: 'quote with quote body missing → ask (fixed question)', draft: { ...quoteDraft(1), quote: null }, ctx: ctx(), expect: { action: 'ask', question: MUNSHI_BAND_QUESTION.en } },
    { name: 'goods RFQ → skip goods_rfq whatever the model said', draft: quoteDraft(230_000), ctx: ctx({ rfqKind: 'goods' }), expect: { action: 'skip', skip_reason: 'goods_rfq', quote: null } },
    { name: 'already quoted → skip already_quoted', draft: quoteDraft(230_000), ctx: ctx({ alreadyQuoted: true }), expect: { action: 'skip', skip_reason: 'already_quoted' } },
    { name: 'window lapsed → skip window_lapsed', draft: quoteDraft(230_000), ctx: ctx({ windowLapsed: true }), expect: { action: 'skip', skip_reason: 'window_lapsed' } },
    { name: 'ask with a question → ask, no basis', draft: { ...quoteDraft(1), action: 'ask', quote: null, question: 'How many GSTINs need filing each month?' }, ctx: ctx(), expect: { action: 'ask', question: 'How many GSTINs need filing each month?', basisLen: 0 } },
    { name: 'ask without a question → fixed question', draft: { ...quoteDraft(1), action: 'ask', quote: null, question: null }, ctx: ctx(), expect: { action: 'ask', question: MUNSHI_BAND_QUESTION.en } },
    { name: 'ask in Telugu → Telugu fixed question', draft: { ...quoteDraft(1), action: 'ask', quote: null, question: null }, ctx: ctx({ locale: 'te' }), expect: { action: 'ask', question: MUNSHI_BAND_QUESTION.te } },
    { name: 'skip without a reason → other', draft: { ...quoteDraft(1), action: 'skip', quote: null, skip_reason: null }, ctx: ctx(), expect: { action: 'skip', skip_reason: 'other' } },
    { name: 'skip out_of_capability kept', draft: { ...quoteDraft(1), action: 'skip', quote: null, skip_reason: 'out_of_capability' }, ctx: ctx(), expect: { action: 'skip', skip_reason: 'out_of_capability', quote: null, question: null } },
    { name: "model's basis list is ignored (code rows only)", draft: quoteDraft(230_000, { basis: [{ price_book_id: U4, price_paise: 1, confirmed_at: '2026-01-01T00:00:00Z', accepted: true }] }), ctx: ctx(), expect: { action: 'quote', basisLen: 3 } },
  ]
  for (const c of cases) {
    it(c.name, () => {
      const out = clampMunshiDraft(c.draft, c.ctx)
      expect(munshiDraftSchema.safeParse(out).success).toBe(true)
      const { basisLen, ...rest } = c.expect
      expect(out).toMatchObject(rest)
      if (basisLen !== undefined) expect(out.basis).toHaveLength(basisLen)
      if (out.action === 'quote') {
        expect(out.basis.map((b) => b.price_book_id)).not.toContain(U4)
        expect(out.question).toBeNull()
        expect(out.skip_reason).toBeNull()
      }
      if (out.action !== 'quote') expect(out.quote).toBeNull()
      expect(out.rationale.length).toBeGreaterThanOrEqual(1)
      expect(out.rationale.length).toBeLessThanOrEqual(4)
    })
  }
  it('clamp notes land in the rationale in the provider locale', () => {
    const out = clampMunshiDraft(quoteDraft(1), ctx({ locale: 'hi' }))
    expect(out.action).toBe('ask')
    expect(out.rationale.at(-1)).toContain('मुंशी')
  })
})

describe('the voice allow-list', () => {
  const yes: [string, string][] = [
    ['yes', 'en'], ['Yes.', 'en'], ['YES SEND IT', 'en'], ['ok, send', 'en'], ['okay send it!', 'en'], ['go ahead', 'en'], ['approve', 'en'], ['approved 👍', 'en'], ['confirm and send', 'en'], ['yes please send', 'en'],
    ['haan bhej do', 'hi'], ['Haan, bhej do.', 'hi'], ['bhej do', 'hi'], ['theek hai bhej do', 'hi'], ['हाँ भेज दो', 'hi'], ['हां भेज दो', 'hi'], ['भेज दो', 'hi'], ['haan', 'hi'], ['yes send', 'hi'],
    ['avunu pampandi', 'te'], ['Avunu, pampandi', 'te'], ['అవును పంపండి', 'te'], ['sare pampandi', 'te'], ['పంపండి', 'te'], ['ok send', 'te'],
    ['sari anuppu', 'ta'], ['seri anuppu', 'ta'], ['சரி அனுப்பு', 'ta'], ['ஆமா அனுப்பு', 'ta'], ['anuppungal', 'ta'], ['yes', 'ta'],
  ]
  const no: [string, string][] = [
    ['yes but change the price', 'en'], ['yes but make it 3000', 'en'], ['no', 'en'], ['no dont send', 'en'], ['ok', 'en'], ['okay', 'en'], ['maybe', 'en'], ['hmm', 'en'], ['send it tomorrow', 'en'], ['yes send it but reduce the price', 'en'],
    ['haan lekin price badha do', 'hi'], ['nahi', 'hi'], ['nahi bhejo', 'hi'], ['theek hai', 'hi'], ['haan par daam badhao', 'hi'], ['हाँ लेकिन कीमत बढ़ाओ', 'hi'], ['mat bhejo', 'hi'],
    ['vaddu', 'te'], ['sare', 'te'], ['avunu kani dhara penchandi', 'te'], ['pampoddu', 'te'],
    ['sari', 'ta'], ['venda', 'ta'], ['sari aana vilai maathu', 'ta'], ['anuppa venda', 'ta'],
    ['', 'en'], ['   ', 'hi'], ['yes yes yes yes yes yes yes', 'en'],
  ]
  it(`${yes.length} positives approve`, () => {
    for (const [t, l] of yes) expect(isUnambiguousYes(t, l), `${l}: ${t}`).toBe(true)
  })
  it(`${no.length} negatives do not`, () => {
    for (const [t, l] of no) expect(isUnambiguousYes(t, l), `${l}: ${t}`).toBe(false)
  })
  it('every phrase is ≤ 6 words and already normalised; every locale has a list', () => {
    for (const l of MUNSHI_LOCALES) {
      expect(MUNSHI_YES_PHRASES[l].length).toBeGreaterThan(5)
      for (const p of MUNSHI_YES_PHRASES[l]) {
        expect(p.split(' ').length, p).toBeLessThanOrEqual(6)
        expect(normaliseUtterance(p), p).toBe(p)
      }
    }
  })
  it('normaliseUtterance folds case, punctuation, emoji and width', () => {
    expect(normaliseUtterance('  YES,  Send   it!!! 👍 ')).toBe('yes send it')
    expect(normaliseUtterance('ｙｅｓ')).toBe('yes')
  })
})

describe('rendering + buttons', () => {
  it('renderMunshiDraft carries price, days, basis and no ids', () => {
    const out = clampMunshiDraft(quoteDraft(230_000), ctx())
    const text = renderMunshiDraft(out, 'en', 'GST filing for a garment unit')
    expect(text).toContain('₹2,300')
    expect(text).toContain('5 days')
    expect(text).toContain('Based on 3 of your quotes: ₹2,000–₹2,500')
    expect(text).not.toContain(U1)
    expect(text).toContain('Tap Approve')
    const hi = renderMunshiDraft(out, 'hi', 'GST filing')
    expect(hi).toContain('मुंशी')
  })
  it('an ask renders the question; a skip has no tap line', () => {
    const ask = clampMunshiDraft({ ...quoteDraft(1), action: 'ask', quote: null, question: 'How many GSTINs?' }, ctx())
    expect(renderMunshiDraft(ask, 'en', 'GST')).toContain('How many GSTINs?')
    const skip = clampMunshiDraft(quoteDraft(1), ctx({ rfqKind: 'goods' }))
    expect(renderMunshiDraft(skip, 'en', 'Steel')).not.toContain('Tap Approve')
  })
  it('parseMunshiButton accepts only approve|edit|skip:<uuid>', () => {
    expect(parseMunshiButton(`approve:${U1}`)).toEqual({ action: 'approve', runId: U1 })
    expect(parseMunshiButton(`EDIT:${U1.toUpperCase()}`)).toEqual({ action: 'edit', runId: U1 })
    expect(parseMunshiButton(`skip:${U1}`)?.action).toBe('skip')
    expect(parseMunshiButton(`confirm:${U1}`)).toBeNull()
    expect(parseMunshiButton('approve:nope')).toBeNull()
    expect(parseMunshiButton(null)).toBeNull()
  })
})
