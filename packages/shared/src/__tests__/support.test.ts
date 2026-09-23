import { describe, expect, it } from 'vitest'
import {
  AGENT_SETTING_DEFS,
  AGENT_TASK_CLASSES,
  AI_DECISION_FEATURES,
  HOW_TO_TOPICS,
  ORDER_STATUSES,
  SUPPORT_COPY,
  SUPPORT_INTENTS,
  SUPPORT_LOCALES,
  SUPPORT_REPLY_KEYS,
  SUPPORT_SLOT_NAMES,
  isToolAllowed,
  nudgeSchema,
  numbersAccountedFor,
  renderSupportReply,
  resolveSupportReply,
  statusLabel,
  supportIntentSchema,
  supportTicketSummarySchema,
  toolsForPersona,
  type SupportLookupResult,
  type SupportOrderView,
  type SupportRfqView,
} from '../index'

const SLA = { acknowledge_hours: 24, resolve_days: 15 }
const CONTACT = 'support@amclub.in / +91 83411 15455'
const base = (role: 'buyer' | 'provider'): SupportLookupResult => ({ role, sla: SLA, support_contact: CONTACT })
const order = (status: string, extra: Partial<SupportOrderView> = {}): SupportOrderView => ({ id: 'o1', order_number: 'AMC-2026-000123', title: 'GST filing', status, amount: '₹2,500', earning: '₹2,375', eta_date: '12 Oct 2026', updated_at: '2026-09-22T00:00:00Z', payout: null, refund: null, ...extra })
const rfq = (status: string, extra: Partial<SupportRfqView> = {}): SupportRfqView => ({ id: 'r1', title: 'Monthly GST filing', status, quote_count: 0, max_quotes: 7, expires_at: '25 Sep 2026', my_quote: null, ...extra })

describe('S2.3 registries', () => {
  it('support_lookup (confirm:false GET) and nudge_counterparty (confirm:true POST) exist for buyer AND provider; isToolAllowed sees both', () => {
    for (const persona of ['buyer', 'provider'] as const) {
      const tools = Object.fromEntries(toolsForPersona(persona).map((t) => [t.name, t]))
      expect(tools['support_lookup']).toMatchObject({ confirm: false })
      expect(tools['support_lookup']!.wraps.startsWith('GET ')).toBe(true)
      expect(tools['nudge_counterparty']).toMatchObject({ confirm: true })
      expect(tools['nudge_counterparty']!.wraps.startsWith('POST ')).toBe(true)
      expect(isToolAllowed(persona, 'support_lookup')).toBe(true)
      expect(isToolAllowed(persona, 'nudge_counterparty')).toBe(true)
    }
    expect(isToolAllowed('ops', 'nudge_counterparty')).toBe(false)
  })
  it('task classes, decision feature, settings', () => {
    expect(AGENT_TASK_CLASSES).toContain('support_intent')
    expect(AGENT_TASK_CLASSES).toContain('support_reply')
    expect(AI_DECISION_FEATURES).toContain('support_nudge')
    expect(AGENT_SETTING_DEFS.support_escalate_after_turns.default).toBe(2)
    expect(AGENT_SETTING_DEFS.support_nudge_cooldown_hours.default).toBe(24)
    expect(AGENT_SETTING_DEFS.support_ops_quiet_hours.default).toBeNull()
    expect(AGENT_SETTING_DEFS.support_ops_quiet_hours.schema.safeParse({ from: '22:00', to: '08:00' }).success).toBe(true)
    expect(AGENT_SETTING_DEFS.support_ops_quiet_hours.schema.safeParse({ from: '25:00', to: '08:00' }).success).toBe(false)
  })
})

describe('supportIntentSchema — no reply text, by design', () => {
  const good = { intent: 'order_status', as_role: null, order_ref: 'latest', rfq_ref: null, how_to_topic: null, escalate: false, escalate_reason: null, ops_summary: null, language: 'en' }
  it('accepts a classification; rejects a reply field, a tool field, an unknown intent', () => {
    expect(supportIntentSchema.safeParse(good).success).toBe(true)
    expect(supportIntentSchema.safeParse({ ...good, reply: 'Your order is fine' }).success).toBe(false)
    expect(supportIntentSchema.safeParse({ ...good, tool: 'nudge_counterparty' }).success).toBe(false)
    expect(supportIntentSchema.safeParse({ ...good, intent: 'refund_now' }).success).toBe(false)
    expect(supportTicketSummarySchema.safeParse({ summary: 'Buyer says the provider stopped replying.', suggested_next: 'call_user' }).success).toBe(true)
    expect(supportTicketSummarySchema.safeParse({ summary: 'x', suggested_next: 'refund_now' }).success).toBe(false)
    expect(nudgeSchema.safeParse({ subject_kind: 'order', subject_id: '11111111-1111-4111-8111-111111111111' }).success).toBe(true)
    expect(nudgeSchema.safeParse({ subject_kind: 'order', subject_id: 'x', body: 'hi' }).success).toBe(false)
  })
})

describe('resolveSupportReply — the reply matrix', () => {
  const rows: { name: string; intent: (typeof SUPPORT_INTENTS)[number]; lookup: SupportLookupResult; key: string; action?: boolean }[] = [
    { name: 'greeting', intent: 'greeting', lookup: base('buyer'), key: 'greeting' },
    { name: 'complaint → escalated', intent: 'complaint', lookup: { ...base('buyer'), ticket_ref: 'T-1' }, key: 'escalated' },
    { name: 'dispute language → escalated', intent: 'dispute_language', lookup: base('buyer'), key: 'escalated' },
    { name: 'payment problem → escalated', intent: 'payment_problem', lookup: base('provider'), key: 'escalated' },
    { name: 'other → unclear', intent: 'other', lookup: base('buyer'), key: 'unclear' },
    { name: 'how_to refund', intent: 'how_to', lookup: { ...base('buyer'), how_to_topic: 'refund' }, key: 'how_to.refund' },
    { name: 'how_to contact_human', intent: 'how_to', lookup: { ...base('buyer'), how_to_topic: 'contact_human' }, key: 'how_to.contact_human' },
    { name: 'how_to without a topic → other', intent: 'how_to', lookup: base('buyer'), key: 'how_to.other' },
    { name: 'order none', intent: 'order_status', lookup: { ...base('buyer'), order: null, orders_count: 0 }, key: 'order_status.none' },
    { name: 'order not found (has others)', intent: 'order_status', lookup: { ...base('buyer'), order: null, orders_count: 3 }, key: 'order_status.not_found' },
    { name: 'order placed + nudge offered', intent: 'order_status', lookup: { ...base('buyer'), order: order('placed'), nudge_subject: { kind: 'order', id: 'o1', active: true, capped: false } }, key: 'order_status.placed', action: true },
    { name: 'order in_progress + nudge capped → no action', intent: 'order_status', lookup: { ...base('buyer'), order: order('in_progress'), nudge_subject: { kind: 'order', id: 'o1', active: true, capped: true } }, key: 'order_status.in_progress', action: false },
    { name: 'order delivered', intent: 'order_status', lookup: { ...base('buyer'), order: order('delivered') }, key: 'order_status.delivered' },
    { name: 'order completed (no nudge: terminal)', intent: 'order_status', lookup: { ...base('buyer'), order: order('completed'), nudge_subject: { kind: 'order', id: 'o1', active: false, capped: false } }, key: 'order_status.completed', action: false },
    { name: 'order disputed', intent: 'order_status', lookup: { ...base('buyer'), order: order('disputed') }, key: 'order_status.disputed' },
    { name: 'order resolved_partial', intent: 'order_status', lookup: { ...base('buyer'), order: order('resolved_partial') }, key: 'order_status.resolved' },
    { name: 'order auto_cancelled', intent: 'order_status', lookup: { ...base('buyer'), order: order('auto_cancelled') }, key: 'order_status.cancelled' },
    { name: 'order refunded', intent: 'order_status', lookup: { ...base('buyer'), order: order('refunded') }, key: 'order_status.refunded' },
    { name: 'order reviewed', intent: 'order_status', lookup: { ...base('provider'), order: order('reviewed') }, key: 'order_status.reviewed' },
    { name: 'payment paid (order exists ⇒ paid)', intent: 'payment_status', lookup: { ...base('buyer'), order: order('accepted') }, key: 'payment_status.paid' },
    { name: 'payment refunded', intent: 'payment_status', lookup: { ...base('buyer'), order: order('refunded') }, key: 'payment_status.refunded' },
    { name: 'payment refund pending (cancelled)', intent: 'payment_status', lookup: { ...base('buyer'), order: order('cancelled_by_buyer') }, key: 'payment_status.refund_pending' },
    { name: 'payment refund pending (refund row)', intent: 'payment_status', lookup: { ...base('buyer'), order: order('in_progress', { refund: { status: 'processing' } }) }, key: 'payment_status.refund_pending' },
    { name: 'payment none', intent: 'payment_status', lookup: { ...base('buyer'), order: null, orders_count: 0 }, key: 'payment_status.none' },
    { name: 'payout not due (in_progress)', intent: 'payout_status', lookup: { ...base('provider'), order: order('in_progress') }, key: 'payout_status.not_due' },
    { name: 'payout scheduled (completed, no payout row)', intent: 'payout_status', lookup: { ...base('provider'), order: order('completed') }, key: 'payout_status.scheduled' },
    { name: 'payout processing', intent: 'payout_status', lookup: { ...base('provider'), order: order('completed', { payout: { status: 'processing', scheduled_for: null, amount: '₹2,375' } }) }, key: 'payout_status.processing' },
    { name: 'payout paid', intent: 'payout_status', lookup: { ...base('provider'), order: order('completed', { payout: { status: 'paid', scheduled_for: null, amount: '₹2,375' } }) }, key: 'payout_status.paid' },
    { name: 'payout failed', intent: 'payout_status', lookup: { ...base('provider'), order: order('completed', { payout: { status: 'failed', scheduled_for: null, amount: null } }) }, key: 'payout_status.failed' },
    { name: 'payout held (dispute wins over the row)', intent: 'payout_status', lookup: { ...base('provider'), order: order('disputed', { payout: { status: 'held', scheduled_for: null, amount: null } }) }, key: 'payout_status.held_dispute' },
    { name: 'payout held (bank)', intent: 'payout_status', lookup: { ...base('provider'), order: order('completed', { payout: { status: 'held', scheduled_for: null, amount: null } }) }, key: 'payout_status.held' },
    { name: 'payout none', intent: 'payout_status', lookup: { ...base('provider'), order: null, orders_count: 0 }, key: 'payout_status.none' },
    { name: 'rfq none', intent: 'rfq_status', lookup: { ...base('buyer'), rfq: null, rfqs_count: 0 }, key: 'rfq_status.none' },
    { name: 'rfq not found', intent: 'rfq_status', lookup: { ...base('buyer'), rfq: null, rfqs_count: 2 }, key: 'rfq_status.not_found' },
    { name: 'rfq open no quotes + nudge', intent: 'rfq_status', lookup: { ...base('buyer'), rfq: rfq('open'), nudge_subject: { kind: 'rfq', id: 'r1', active: true, capped: false } }, key: 'rfq_status.open_no_quotes', action: true },
    { name: 'rfq open quoted (no nudge)', intent: 'rfq_status', lookup: { ...base('buyer'), rfq: rfq('quoted', { quote_count: 3 }), nudge_subject: { kind: 'rfq', id: 'r1', active: true, capped: false } }, key: 'rfq_status.open_quoted', action: false },
    { name: 'rfq accepted', intent: 'rfq_status', lookup: { ...base('buyer'), rfq: rfq('accepted') }, key: 'rfq_status.accepted' },
    { name: 'rfq expired', intent: 'rfq_status', lookup: { ...base('buyer'), rfq: rfq('expired') }, key: 'rfq_status.expired' },
    { name: 'rfq cancelled', intent: 'rfq_status', lookup: { ...base('buyer'), rfq: rfq('cancelled') }, key: 'rfq_status.cancelled' },
    { name: 'quote: no matched / quoted request at all → no_matches (never a blank title)', intent: 'quote_status', lookup: { ...base('provider'), rfq: null, rfqs_count: 0 }, key: 'quote_status.no_matches' },
    { name: 'quote none (provider has not quoted)', intent: 'quote_status', lookup: { ...base('provider'), rfq: rfq('open'), rfqs_count: 1 }, key: 'quote_status.none' },
    { name: 'quote submitted + nudge', intent: 'quote_status', lookup: { ...base('provider'), rfq: rfq('quoted', { quote_count: 2, my_quote: { status: 'submitted', price: '₹2,500' } }), nudge_subject: { kind: 'rfq', id: 'r1', active: true, capped: false } }, key: 'quote_status.submitted', action: true },
    { name: 'quote accepted', intent: 'quote_status', lookup: { ...base('provider'), rfq: rfq('accepted', { my_quote: { status: 'accepted', price: '₹2,500' } }) }, key: 'quote_status.accepted' },
    { name: 'quote declined', intent: 'quote_status', lookup: { ...base('provider'), rfq: rfq('quoted', { my_quote: { status: 'declined', price: '₹2,500' } }) }, key: 'quote_status.declined' },
    { name: 'quote expired', intent: 'quote_status', lookup: { ...base('provider'), rfq: rfq('expired', { my_quote: { status: 'expired', price: '₹2,500' } }) }, key: 'quote_status.expired' },
    { name: 'quote not found', intent: 'quote_status', lookup: { ...base('provider'), rfq: null, rfqs_count: 4 }, key: 'quote_status.not_found' },
    { name: 'nudge request → confirm', intent: 'nudge_request', lookup: { ...base('buyer'), nudge_subject: { kind: 'order', id: 'o1', active: true, capped: false } }, key: 'nudge.confirm', action: true },
    { name: 'nudge request capped', intent: 'nudge_request', lookup: { ...base('buyer'), nudge_subject: { kind: 'order', id: 'o1', active: true, capped: true } }, key: 'nudge.capped', action: false },
    { name: 'nudge request inactive subject', intent: 'nudge_request', lookup: { ...base('buyer'), nudge_subject: { kind: 'order', id: 'o1', active: false, capped: false } }, key: 'nudge.out_of_window', action: false },
    { name: 'nudge request no subject', intent: 'nudge_request', lookup: base('buyer'), key: 'nudge.no_subject', action: false },
  ]
  for (const r of rows) {
    it(r.name, () => {
      const out = resolveSupportReply(r.intent, r.lookup)
      expect(out.key).toBe(r.key)
      if (r.action !== undefined) expect(!!out.action).toBe(r.action)
      if (out.action) expect(out.action.tool).toBe('nudge_counterparty')
      expect(SUPPORT_REPLY_KEYS).toContain(out.key)
    })
  }
  it('every order status has a reply key', () => {
    for (const s of ORDER_STATUSES) {
      const out = resolveSupportReply('order_status', { ...base('buyer'), order: order(s) })
      expect(out.key.startsWith('order_status.') && out.key !== 'order_status.not_found', s).toBe(true)
    }
  })
})

describe('copy completeness + rendering + the numbers rule', () => {
  it('every key × locale exists, uses only known slots, and renders without a leftover {', () => {
    for (const l of SUPPORT_LOCALES) {
      for (const k of SUPPORT_REPLY_KEYS) {
        const t = SUPPORT_COPY[l][k]
        expect(typeof t === 'string' && t.length > 10, `${l}/${k}`).toBe(true)
        for (const m of t.matchAll(/\{([a-z_]+)\}/g)) expect(SUPPORT_SLOT_NAMES as readonly string[], `${l}/${k} slot ${m[1]}`).toContain(m[1])
        expect(renderSupportReply(k, {}, l)).not.toMatch(/[{}]/)
      }
    }
    for (const t of HOW_TO_TOPICS) expect(SUPPORT_REPLY_KEYS).toContain(`how_to.${t}`)
  })
  it('renders slots; unknown slots vanish; status labels follow the app (en/hi) and exist in te/ta', () => {
    const text = renderSupportReply('order_status.in_progress', { order_number: 'AMC-1', title: 'GST', eta_date: '12 Oct', amount: '₹2,500' }, 'en')
    expect(text).toContain('AMC-1')
    expect(text).toContain('₹2,500')
    expect(statusLabel('order', 'in_progress', 'en')).toBe('In progress')
    expect(statusLabel('order', 'in_progress', 'hi')).toBe('प्रगति में')
    expect(statusLabel('rfq', 'quoted', 'hi')).toBe('कोटेशन मिल रहे हैं')
    expect(statusLabel('order', 'resolved_partial', 'te').length).toBeGreaterThan(2)
    expect(statusLabel('payout', 'held', 'ta').length).toBeGreaterThan(2)
  })
  it('the numbers rule: every digit run in a rendered reply is in the lookup payload or in the copy', () => {
    const o = order('in_progress')
    const reply = resolveSupportReply('order_status', { ...base('buyer'), order: o })
    const text = renderSupportReply(reply.key, reply.slots, 'en')
    const template = SUPPORT_COPY.en[reply.key]
    const r = numbersAccountedFor(text, [JSON.stringify(o), template, JSON.stringify(SLA), CONTACT])
    expect(r.ok, r.missing.join(',')).toBe(true)
    // a reply that smuggled a number NOT in the payload fails the rule
    const bad = numbersAccountedFor(text + ' Your refund of ₹9,999 is coming.', [JSON.stringify(o), template, JSON.stringify(SLA), CONTACT])
    expect(bad.ok).toBe(false)
    expect(bad.missing).toContain('999')
  })
})
