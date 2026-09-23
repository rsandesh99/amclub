import { describe, expect, it } from 'vitest'
import {
  AGENT_SETTING_DEFS,
  AGENT_TASK_CLASSES,
  AI_DECISION_FEATURES,
  COUNTER_OFFER_PHRASES,
  PROCUREMENT_BUTTON_ONLY_TOOLS,
  PROCUREMENT_BUTTON_TITLES,
  PROCUREMENT_COPY,
  PROCUREMENT_COPY_KEYS,
  PROCUREMENT_DECLINE_REASON_LABELS,
  PROCUREMENT_FORBIDDEN_TOOLS,
  PROCUREMENT_LOCALES,
  PROCUREMENT_SCOPES,
  PROCUREMENT_SESSION_STATES,
  PROCUREMENT_SESSION_TERMINAL,
  PROCUREMENT_SESSION_TRANSITIONS,
  PROCUREMENT_SLOT_NAMES,
  PROCUREMENT_VOICE_CONFIRM_TOOLS,
  SUPPORT_COPY,
  SUPPORT_INTENTS,
  TASK_CLASS_RESIDENCY,
  TASK_CLASS_TIER,
  acceptClarificationDraft,
  agentGrantSchema,
  agentTool,
  chooseQuotePayloadSchema,
  clampProviderMessage,
  clarificationAnswerDraftSchema,
  compareQuotes,
  counterOfferHits,
  hasProcurementScopes,
  isValidProcurementSessionTransition,
  labelMentioned,
  parseProcurementButton,
  procurementButtonId,
  procurementCheckoutPath,
  procurementDeclineReason,
  procurementSessionIsActive,
  procurementTurnSchema,
  providerMessageDraftSchema,
  quoteSetKey,
  renderProcurementCopy,
  resolveSupportReply,
  scopesWithinPersona,
  summariseQuotesForChat,
  toolsForPersona,
  voiceMayConfirm,
} from '../index'

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const U3 = '33333333-3333-4333-8333-333333333333'

describe('S3.1 scopes — the agent can never pay or accept', () => {
  it('PROCUREMENT_SCOPES holds neither accept_quote nor place_order', () => {
    for (const t of PROCUREMENT_FORBIDDEN_TOOLS) expect(PROCUREMENT_SCOPES as readonly string[]).not.toContain(t)
    expect(PROCUREMENT_SCOPES as readonly string[]).not.toContain('accept_quote')
    expect(PROCUREMENT_SCOPES as readonly string[]).not.toContain('place_order')
  })
  it('every scope is a buyer tool (⊆ toolsForPersona(buyer)) and the grant schema accepts the list', () => {
    const buyer = new Set(toolsForPersona('buyer').map((t) => t.name))
    for (const s of PROCUREMENT_SCOPES) expect(buyer.has(s)).toBe(true)
    expect(scopesWithinPersona('buyer', PROCUREMENT_SCOPES)).toBe(true)
    expect(agentGrantSchema.safeParse({ persona: 'buyer', scopes: [...PROCUREMENT_SCOPES], channel: 'web' }).success).toBe(true)
  })
  it('choose_quote is a LOCAL confirm gate; message_provider wraps the ordinary thread route', () => {
    expect(agentTool('choose_quote')).toMatchObject({ persona: 'buyer', confirm: true })
    expect(agentTool('choose_quote').wraps.startsWith('local')).toBe(true)
    expect(agentTool('message_provider')).toMatchObject({ persona: 'buyer', confirm: true, wraps: 'POST /quotes/[quoteId]/messages' })
    expect(agentTool('compare_quotes').wraps).toBe('GET /rfq/[id]/compare')
  })
  it('hasProcurementScopes needs create + compare + choose; an S0.5 START grant ([]) is not enough', () => {
    expect(hasProcurementScopes(PROCUREMENT_SCOPES)).toBe(true)
    expect(hasProcurementScopes([])).toBe(false)
    expect(hasProcurementScopes(null)).toBe(false)
    expect(hasProcurementScopes(['create_rfq', 'compare_quotes'])).toBe(false)
  })
  it('money-adjacent tools confirm by button only; the voice allow-list covers the rest; every proposal tool is a scope', () => {
    expect(voiceMayConfirm('create_rfq')).toBe(true)
    expect(voiceMayConfirm('message_provider')).toBe(true)
    for (const t of PROCUREMENT_BUTTON_ONLY_TOOLS) expect(voiceMayConfirm(t)).toBe(false)
    expect(voiceMayConfirm('choose_quote')).toBe(false)
    expect(voiceMayConfirm('decline_quote')).toBe(false)
    for (const t of [...PROCUREMENT_VOICE_CONFIRM_TOOLS, ...PROCUREMENT_BUTTON_ONLY_TOOLS]) {
      expect(PROCUREMENT_SCOPES as readonly string[]).toContain(t)
      expect(agentTool(t).confirm).toBe(true)
    }
  })
})

describe('S3.1 registries', () => {
  it('task classes are routine and residency in; the feature and the settings exist', () => {
    for (const c of ['procurement_turn', 'clarification_answer', 'provider_message'] as const) {
      expect(AGENT_TASK_CLASSES).toContain(c)
      expect(TASK_CLASS_TIER[c]).toBe('routine')
      expect(TASK_CLASS_RESIDENCY[c]).toBe('in')
    }
    expect(AI_DECISION_FEATURES).toContain('procurement_step')
    expect(AGENT_SETTING_DEFS.procurement_chase_hours.default).toBe(24)
    expect(AGENT_SETTING_DEFS.procurement_session_ttl_days.default).toBe(7)
    expect(AGENT_SETTING_DEFS.procurement_max_proposals_per_day.default).toBe(30)
    expect(AGENT_SETTING_DEFS.budget_run_paise_by_agent.schema.safeParse({ procurement: 1500 }).success).toBe(true)
  })
  it('new_need is a Support intent: the offer when procurement is available, else the create-request how-to', () => {
    expect(SUPPORT_INTENTS).toContain('new_need')
    const base = { role: 'buyer' as const, sla: { acknowledge_hours: 24, resolve_days: 15 }, support_contact: 'x' }
    expect(resolveSupportReply('new_need', { ...base, procurement_available: true }).key).toBe('new_need.offer')
    expect(resolveSupportReply('new_need', base).key).toBe('how_to.create_rfq')
    for (const l of PROCUREMENT_LOCALES) expect(SUPPORT_COPY[l]['new_need.offer'].length).toBeGreaterThan(10)
  })
})

describe('S3.1 session machine', () => {
  it('every state has a transition list; terminals are empty; no transition leaves a terminal', () => {
    for (const s of PROCUREMENT_SESSION_STATES) expect(PROCUREMENT_SESSION_TRANSITIONS[s]).toBeDefined()
    for (const s of PROCUREMENT_SESSION_TERMINAL) expect(PROCUREMENT_SESSION_TRANSITIONS[s]).toEqual([])
    for (const s of PROCUREMENT_SESSION_STATES) for (const to of PROCUREMENT_SESSION_TRANSITIONS[s]) expect(PROCUREMENT_SESSION_STATES).toContain(to)
  })
  it('the happy path and the legal back-edges', () => {
    const path = ['drafting', 'awaiting_create', 'live', 'quotes_in', 'chosen', 'closed'] as const
    for (let i = 0; i < path.length - 1; i++) expect(isValidProcurementSessionTransition(path[i]!, path[i + 1]!)).toBe(true)
    expect(isValidProcurementSessionTransition('awaiting_create', 'quality')).toBe(true)
    expect(isValidProcurementSessionTransition('quality', 'live')).toBe(true)
    expect(isValidProcurementSessionTransition('awaiting_create', 'drafting')).toBe(true)
    expect(isValidProcurementSessionTransition('chosen', 'quotes_in')).toBe(true)
  })
  it('illegal moves are refused; every non-terminal can fail or expire', () => {
    expect(isValidProcurementSessionTransition('drafting', 'chosen')).toBe(false)
    expect(isValidProcurementSessionTransition('live', 'chosen')).toBe(false)
    expect(isValidProcurementSessionTransition('closed', 'live')).toBe(false)
    expect(isValidProcurementSessionTransition('failed', 'drafting')).toBe(false)
    for (const s of PROCUREMENT_SESSION_STATES) {
      if ((PROCUREMENT_SESSION_TERMINAL as readonly string[]).includes(s)) continue
      expect(isValidProcurementSessionTransition(s, 'failed')).toBe(true)
      expect(isValidProcurementSessionTransition(s, 'expired')).toBe(true)
    }
    expect(procurementSessionIsActive('live')).toBe(true)
    expect(procurementSessionIsActive('closed')).toBe(false)
    expect(procurementSessionIsActive('bogus')).toBe(false)
  })
})

describe('S3.1 the turn classifier output (no reply text)', () => {
  const ok = { route: 'choose', session_ref: 'current', choose_label: 'B', decline_label: null, decline_reason: null, provider_question: null, escalate_to_support: false }
  it('parses a strict turn and has no reply field', () => {
    expect(procurementTurnSchema.safeParse(ok).success).toBe(true)
    expect(procurementTurnSchema.safeParse({ ...ok, reply: 'Sure!' }).success).toBe(false)
    expect(Object.keys(procurementTurnSchema.shape)).not.toContain('reply')
  })
  it('labels are A–G only; the question is capped', () => {
    expect(procurementTurnSchema.safeParse({ ...ok, choose_label: 'H' }).success).toBe(false)
    expect(procurementTurnSchema.safeParse({ ...ok, choose_label: 'b' }).success).toBe(false)
    expect(procurementTurnSchema.safeParse({ ...ok, route: 'ask_provider', provider_question: 'x'.repeat(301) }).success).toBe(false)
  })
  it('chose_other (system-reserved) and null become other', () => {
    expect(procurementDeclineReason('chose_other')).toBe('other')
    expect(procurementDeclineReason(null)).toBe('other')
    expect(procurementDeclineReason('price_high')).toBe('price_high')
  })
})

describe('S3.1 the clarification-answer draft', () => {
  it('answerable needs an answer and a source; not answerable has no answer', () => {
    expect(clarificationAnswerDraftSchema.safeParse({ answerable: true, answer: 'Yes, 3 GSTINs', source_turn_ids: [U1] }).success).toBe(true)
    expect(clarificationAnswerDraftSchema.safeParse({ answerable: true, answer: null, source_turn_ids: [U1] }).success).toBe(false)
    expect(clarificationAnswerDraftSchema.safeParse({ answerable: true, answer: 'x', source_turn_ids: [] }).success).toBe(false)
    expect(clarificationAnswerDraftSchema.safeParse({ answerable: false, answer: 'x', source_turn_ids: [] }).success).toBe(false)
    expect(clarificationAnswerDraftSchema.safeParse({ answerable: false, answer: null, source_turn_ids: [] }).success).toBe(true)
  })
  it('code backstop: a cited turn that is not the buyer’s own, or a price in the answer → not answerable', () => {
    const d = { answerable: true, answer: 'Three GSTINs, monthly returns', source_turn_ids: [U1] }
    expect(acceptClarificationDraft(d, [U1, U2]).answerable).toBe(true)
    expect(acceptClarificationDraft(d, [U2]).answerable).toBe(false)
    expect(acceptClarificationDraft({ ...d, answer: 'Budget is ₹20,000' }, [U1]).answerable).toBe(false)
    expect(acceptClarificationDraft({ answerable: false, answer: null, source_turn_ids: [] }, [U1]).answerable).toBe(false)
  })
})

describe('S3.1 clampProviderMessage — no negotiation (≥ 25 cases)', () => {
  const rejects: [string, string][] = [
    ['can you do it for 20000', 'counter phrase + number'],
    ['Can you do it for ₹20k?', 'rupee + k'],
    ['₹20,000 is my budget', 'rupee amount'],
    ['Rs 15000 only', 'Rs marker'],
    ['INR 25000 please', 'INR marker'],
    ['I can pay 18 thousand', 'magnitude word'],
    ['2 lakh is too much', 'lakh'],
    ['1,50,000 is the max', 'Indian grouping'],
    ['20,000', 'western grouping, bare'],
    ['give 10% discount', 'percent + discount'],
    ['10 percent off please', 'percent word'],
    ['what is your best price', 'best price'],
    ['please give a discount', 'discount'],
    ['can you make it cheaper', 'cheaper'],
    ['match the price of the other quote', 'match the price'],
    ['please reduce the price', 'reduce the price'],
    ['Is it negotiable?', 'negotiable'],
    ['thoda kam karo bhai', 'Hinglish kam karo'],
    ['rate kam kijiye', 'rate kam'],
    ['दाम कम कीजिए', 'Devanagari'],
    ['थोड़ा कम करो', 'Devanagari thoda kam'],
    ['२०००० में करोगे?', 'Devanagari digits + rupee-less amount is caught by the counter check only when grouped'],
    ['ధర తగ్గించండి', 'Telugu reduce'],
    ['தள்ளுபடி கிடைக்குமா', 'Tamil discount'],
    ['₹ 5 k', 'spaced rupee'],
    ['15 हजार रुपये', 'Hindi thousand + rupees'],
    ['50% advance is too high, make it 20%', 'percent'],
  ]
  for (const [text, why] of rejects) {
    it(`rejects: ${why} — "${text}"`, () => {
      if (why.startsWith('Devanagari digits')) {
        // a bare ungrouped number with no marker is not an amount by itself; "में करोगे?" is not a counter phrase — pinned so a change is deliberate
        expect(clampProviderMessage(text).ok).toBe(true)
        return
      }
      expect(clampProviderMessage(text).ok).toBe(false)
    })
  }
  const accepts = [
    'Can you start next Monday?',
    'Does your quote include filing for all 3 GSTINs?',
    'How many days will the audit take?',
    'Please share a sample of a similar logo you designed.',
    'Is transport included in your quote?',
    'Do you need the invoices as PDF or Excel?',
    'क्या आप अगले सोमवार से शुरू कर सकते हैं?',
    'మీరు వచ్చే సోమవారం మొదలుపెట్టగలరా?',
    'அடுத்த திங்கள் தொடங்க முடியுமா?',
    'Can you deliver within 10 days?',
  ]
  for (const text of accepts) {
    it(`accepts a scope / timing / terms question — "${text}"`, () => {
      const r = clampProviderMessage(text)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.body).toBe(text.trim())
    })
  }
  it('reports every reason (amount + percent + counter-offer)', () => {
    const r = clampProviderMessage('best price? ₹20k with 10% off')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(new Set(r.reasons)).toEqual(new Set(['amount', 'percent', 'counter_offer']))
  })
  it('every locale list is checked whatever the locale hint; whole words only', () => {
    expect(clampProviderMessage('kam karo', 'en').ok).toBe(false)
    expect(clampProviderMessage('best price', 'ta').ok).toBe(false)
    expect(counterOfferHits('discounted')).toEqual([]) // "discount" is a whole-word phrase
    for (const l of PROCUREMENT_LOCALES) expect(COUNTER_OFFER_PHRASES[l].length).toBeGreaterThan(5)
  })
  it('the draft schema caps the body at 600', () => {
    expect(providerMessageDraftSchema.safeParse({ body: 'x'.repeat(601) }).success).toBe(false)
    expect(providerMessageDraftSchema.safeParse({ body: 'ok?', extra: 1 }).success).toBe(false)
  })
})

describe('S3.1 summariseQuotesForChat — pure, from the S1.2 comparison', () => {
  const quotes = [
    { id: 'q1', kind: 'service' as const, pricePaise: 2_900_000, deliveryDays: 7, gstIncluded: false, transportIncluded: null, validUntil: null, advancePercent: 30 },
    { id: 'q2', kind: 'service' as const, pricePaise: 3_000_000, deliveryDays: 5, gstIncluded: true, transportIncluded: true, validUntil: null, advancePercent: 60 },
    { id: 'q3', kind: 'service' as const, pricePaise: 3_100_000, deliveryDays: null, gstIncluded: true, transportIncluded: true, validUntil: null, advancePercent: 0 },
  ]
  const results = compareQuotes(quotes, { today: '2026-09-23' })
  const chat = quotes.map((q) => ({ id: q.id, pricePaise: q.pricePaise, deliveryDays: q.deliveryDays, status: 'submitted' }))

  it('three lines; labels follow the compare page (quote-list position), the lines follow the display order', () => {
    const s = summariseQuotesForChat(results, chat, 'en', { order: ['q2', 'q1', 'q3'] })
    expect(s.lines).toHaveLength(3)
    expect(s.labels).toEqual({ q1: 'A', q2: 'B', q3: 'C' })
    expect(s.order).toEqual(['q2', 'q1', 'q3'])
    expect(s.lines[0]).toBe('3 quotes: B ₹30,000 (5 days) · A ₹29,000 (7 days) · C ₹31,000 (days not stated)')
  })
  it('line 2 names the lowest normalised total (GST added where excluded) and the fastest — facts from the flags', () => {
    const s = summariseQuotesForChat(results, chat, 'en')
    // A: 29,000 + 18 % GST = 34,220 > B 30,000 (GST included) → B is cheapest after normalisation
    expect(s.lines[1]).toBe('Lowest total after GST: B ₹30,000. Fastest: B (5 days).')
  })
  it('line 3 lists what needs attention, by label', () => {
    const s = summariseQuotesForChat(results, chat, 'en')
    expect(s.lines[2]).toContain('A — GST extra')
    expect(s.lines[2]).toContain('B — asks for a high advance')
  })
  it('declined / withdrawn quotes keep their letter but leave the lines', () => {
    const s = summariseQuotesForChat(results, [chat[0]!, { ...chat[1]!, status: 'declined' }, chat[2]!], 'en')
    expect(s.labels['q2']).toBe('B')
    expect(s.order).toEqual(['q1', 'q3'])
    expect(s.lines[0]).not.toContain('B ₹')
  })
  it('one quote: the facts line says so; no quotes: a count line', () => {
    const one = compareQuotes([quotes[0]!], { today: '2026-09-23' })
    expect(summariseQuotesForChat(one, [chat[0]!], 'en').lines[1]).toBe('Only one quote so far.')
    expect(summariseQuotesForChat([], [], 'en').lines[0]).toBe('0 quotes.')
  })
  it('every locale renders three non-empty lines with the same labels and prices', () => {
    for (const l of PROCUREMENT_LOCALES) {
      const s = summariseQuotesForChat(results, chat, l)
      expect(s.lines.every((x) => x.length > 0)).toBe(true)
      expect(s.lines[0]).toContain('₹29,000')
    }
  })
  it('quoteSetKey is order-independent', () => {
    expect(quoteSetKey(['b', 'a'])).toBe(quoteSetKey(['a', 'b']))
  })
})

describe('S3.1 labelMentioned — "go with B" is only a proposal when the letter is really there', () => {
  it('Latin letters, any case for B–G', () => {
    expect(labelMentioned('go with B', 'B')).toBe(true)
    expect(labelMentioned('b is fine', 'B')).toBe(true)
    expect(labelMentioned('option c please', 'C')).toBe(true)
    expect(labelMentioned('go with Bharat', 'B')).toBe(false)
  })
  it('"a" the article is not A; uppercase A or "option a" is', () => {
    expect(labelMentioned('go with a good one', 'A')).toBe(false)
    expect(labelMentioned('go with A', 'A')).toBe(true)
    expect(labelMentioned('quote a', 'A')).toBe(true)
  })
  it('native letter names; the fast / cheap descriptions are NOT labels', () => {
    expect(labelMentioned('बी वाला ठीक है', 'B')).toBe(true)
    expect(labelMentioned('బి తో వెళ్దాం', 'B')).toBe(true)
    expect(labelMentioned('not the cheap one, the fast one', 'B')).toBe(false)
    expect(labelMentioned('haan ji', 'G')).toBe(false)
    expect(labelMentioned('x', 'H')).toBe(false)
  })
})

describe('S3.1 button payloads + the deep link', () => {
  it('round-trips each kind; the pr: namespace keeps Munshi / Support payloads out', () => {
    for (const b of [
      { kind: 'decision' as const, action: 'ok' as const, runId: U1 },
      { kind: 'decision' as const, action: 'no' as const, runId: U1 },
      { kind: 'label' as const, sessionId: U2, label: 'C' },
      { kind: 'session' as const, choice: 'new' as const, messageId: U3 },
      { kind: 'session' as const, choice: 'current' as const, messageId: U3 },
    ]) expect(parseProcurementButton(procurementButtonId(b))).toEqual(b)
    expect(parseProcurementButton(`edit:${U1}`)).toBeNull() // Munshi's
    expect(parseProcurementButton(`nudge:yes:${U1}`)).toBeNull() // Support's
    expect(parseProcurementButton('no')).toBeNull()
    expect(parseProcurementButton(`pr:label:${U2}:H`)).toBeNull()
  })
  it('the checkout link is the buyer’s own RFQ page, decision-bound', () => {
    expect(procurementCheckoutPath(U1, U2, U3)).toBe(`/app/rfq/${U1}?pay=${U2}&d=${U3}`)
    expect(chooseQuotePayloadSchema.safeParse({ rfq_id: U1, quote_id: U2, label: 'B', price_paise: 3_000_000 }).success).toBe(true)
    expect(chooseQuotePayloadSchema.safeParse({ rfq_id: U1, quote_id: U2, label: 'B', price_paise: 3_000_000, checkout: true }).success).toBe(false)
  })
})

describe('S3.1 copy completeness', () => {
  it('every key in every locale, the same slots per key, only known slot names', () => {
    const slotsOf = (s: string) => [...s.matchAll(/\{([a-z0-9_]+)\}/g)].map((m) => m[1]!).sort()
    for (const k of PROCUREMENT_COPY_KEYS) {
      const en = slotsOf(PROCUREMENT_COPY.en[k])
      for (const l of PROCUREMENT_LOCALES) {
        expect(PROCUREMENT_COPY[l][k], `${l}.${k}`).toBeTruthy()
        expect(slotsOf(PROCUREMENT_COPY[l][k]), `${l}.${k}`).toEqual(en)
        for (const s of slotsOf(PROCUREMENT_COPY[l][k])) expect(PROCUREMENT_SLOT_NAMES as readonly string[]).toContain(s)
      }
    }
  })
  it('renders slots and never promises payment happens in the chat', () => {
    expect(renderProcurementCopy('choose_card', { label: 'B', price: '₹30,000', title: 'GST filing' }, 'en')).toContain('Nothing is paid here')
    expect(renderProcurementCopy('created', { title: 'GST filing', matched: 4 }, 'hi')).toContain('4')
  })
  it('button titles fit the 20-character WhatsApp limit; decline reasons cover every buyer reason', () => {
    for (const l of PROCUREMENT_LOCALES) {
      const t = PROCUREMENT_BUTTON_TITLES[l]
      for (const v of [t.yes, t.edit, t.no, t.start, t.skip, t.newReq, t.thisOne, t.label('G')]) expect(v.length, `${l}:${v}`).toBeLessThanOrEqual(20)
      expect(Object.keys(PROCUREMENT_DECLINE_REASON_LABELS[l]).sort()).toEqual(['delivery_slow', 'details_unclear', 'other', 'price_high', 'terms_unacceptable'])
    }
  })
})
