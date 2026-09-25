import { describe, expect, it } from 'vitest'
import type { SupportIntentOutput, SupportOrderView, SupportRfqView } from '@amclub/shared'
import { runSupportTurn, type SupportLookups, type SupportTurnDeps } from './core'

const SLA = { acknowledge_hours: 24, resolve_days: 15 }
const CONTACT = 'support@amclub.in / +91 83411 15455'
const o = (n: number, status: string, extra: Partial<SupportOrderView> = {}): SupportOrderView => ({ id: `o${n}`, order_number: `AMC-2026-00012${n}`, title: `Order ${n}`, status, amount: '₹2,500', earning: '₹2,375', eta_date: '12 Oct 2026', updated_at: '2026-09-22T00:00:00Z', payout: null, refund: null, ...extra })
const r = (n: number, status: string, extra: Partial<SupportRfqView> = {}): SupportRfqView => ({ id: `r${n}`, title: `Request ${n}`, status, quote_count: 0, max_quotes: 7, expires_at: '25 Sep 2026', my_quote: null, ...extra })

function fakeLookups(data: { orders?: SupportOrderView[]; rfqs?: SupportRfqView[]; capped?: boolean; active?: boolean }): SupportLookups & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async listOrders(role) { calls.push(`listOrders:${role}`); return data.orders ?? [] },
    async getOrder(ref, role) { calls.push(`getOrder:${role}:${ref}`); return (data.orders ?? []).find((x) => x.order_number.toLowerCase() === ref.toLowerCase()) ?? null },
    async listRfqs(role) { calls.push(`listRfqs:${role}`); return data.rfqs ?? [] },
    async getRfq(ref, role) { calls.push(`getRfq:${role}:${ref}`); return (data.rfqs ?? []).find((x) => x.title.toLowerCase() === ref.toLowerCase()) ?? null },
    async nudgeState(subject, role) { calls.push(`nudge:${role}:${subject.kind}:${subject.id}`); return { active: data.active ?? true, capped: data.capped ?? false } },
  }
}
const cls = (partial: Partial<SupportIntentOutput>): SupportIntentOutput => ({ intent: 'other', as_role: null, order_ref: null, rfq_ref: null, how_to_topic: null, escalate: false, escalate_reason: null, ops_summary: null, language: 'en', ...partial })
function deps(intent: Partial<SupportIntentOutput>, lookups: SupportLookups, over: Partial<SupportTurnDeps> = {}): SupportTurnDeps {
  return { classify: async () => cls(intent), lookups, settings: { escalateAfterTurns: 2, nudgeCooldownHours: 24 }, sla: SLA, supportContact: CONTACT, ...over }
}
const turn = (text: string, roles: ('buyer' | 'provider')[] = ['buyer'], history: { intents?: SupportIntentOutput['intent'][]; unclearStreak?: number } = {}, openTicket = false) => ({ text, messageId: 'm1', channel: 'support_chat' as const, roles, locale: 'en' as const, history: { intents: history.intents ?? [], unclearStreak: history.unclearStreak ?? 0 }, openTicket })

describe('runSupportTurn — the engine', () => {
  it('order_status "latest" → the latest order, its number and status in the reply, nudge offered, numbers rule ok', async () => {
    const lk = fakeLookups({ orders: [o(3, 'in_progress'), o(2, 'completed')] })
    const res = await runSupportTurn(deps({ intent: 'order_status', order_ref: 'latest' }, lk), turn('where is my order'))
    expect(res.reply.key).toBe('order_status.in_progress')
    expect(res.reply.text).toContain('AMC-2026-000123')
    expect(res.reply.text).toContain('₹2,500')
    expect(res.action?.subject).toEqual({ kind: 'order', id: 'o3' })
    expect(res.lookupRefs.order_id).toBe('o3')
    expect(res.numbers.ok, res.numbers.missing.join(',')).toBe(true)
    expect(res.unclearStreak).toBe(0)
  })
  it('a written order number resolves through getOrder when not in the recent list; an unknown number → not_found', async () => {
    const lk = fakeLookups({ orders: [o(1, 'delivered')] })
    const a = await runSupportTurn(deps({ intent: 'order_status', order_ref: 'amc-2026-000121' }, lk), turn('order AMC-2026-000121?'))
    expect(a.reply.key).toBe('order_status.delivered')
    const b = await runSupportTurn(deps({ intent: 'order_status', order_ref: 'AMC-2026-009999' }, lk), turn('order 9999?'))
    expect(b.reply.key).toBe('order_status.not_found')
    expect(b.reply.text).not.toContain('9999')
    expect(b.numbers.ok).toBe(true)
  })
  it('no orders at all → none (no lookup of a specific order, no nudge)', async () => {
    const lk = fakeLookups({})
    const res = await runSupportTurn(deps({ intent: 'order_status' }, lk), turn('my order?'))
    expect(res.reply.key).toBe('order_status.none')
    expect(res.action).toBeUndefined()
  })
  it('payout_status for a dual-role user wears the provider hat; held while disputed', async () => {
    const lk = fakeLookups({ orders: [o(5, 'disputed')] })
    const res = await runSupportTurn(deps({ intent: 'payout_status', order_ref: 'latest' }, lk), turn('when will I be paid', ['buyer', 'provider']))
    expect(res.role).toBe('provider')
    expect(res.reply.key).toBe('payout_status.held_dispute')
    expect(res.reply.text).toContain('15')
    expect(lk.calls.some((c) => c === 'listOrders:provider')).toBe(true)
  })
  it('as_role from the classifier wins over the default hat', async () => {
    const lk = fakeLookups({ rfqs: [r(1, 'quoted', { quote_count: 2, my_quote: { status: 'submitted', price: '₹2,500' } })] })
    const res = await runSupportTurn(deps({ intent: 'quote_status', as_role: 'provider', rfq_ref: 'latest' }, lk), turn('did the buyer accept my quote', ['buyer', 'provider']))
    expect(res.role).toBe('provider')
    expect(res.reply.key).toBe('quote_status.submitted')
    expect(res.reply.text).toContain('Request 1')
    expect(res.action?.subject.kind).toBe('rfq')
  })
  it('rfq_status by title; open without quotes offers a nudge; capped → no action', async () => {
    const lk = fakeLookups({ rfqs: [r(2, 'open')], capped: true })
    const res = await runSupportTurn(deps({ intent: 'rfq_status', rfq_ref: 'Request 2' }, lk), turn('any quotes on Request 2?'))
    expect(res.reply.key).toBe('rfq_status.open_no_quotes')
    expect(res.action).toBeUndefined()
  })
  it('how_to → the topic template, no lookups beyond the reference lists, numbers from the copy only', async () => {
    const lk = fakeLookups({})
    const res = await runSupportTurn(deps({ intent: 'how_to', how_to_topic: 'fees' }, lk), turn('what are the fees'))
    expect(res.reply.key).toBe('how_to.fees')
    expect(res.reply.text).toContain('5%')
    expect(res.numbers.ok).toBe(true)
    expect(lk.calls.filter((c) => c.startsWith('getOrder') || c.startsWith('nudge'))).toEqual([])
  })
  it('greeting → greeting; other → unclear (streak 1); other again → unclear_again (streak 2 → escalates at the setting)', async () => {
    const lk = fakeLookups({})
    const g = await runSupportTurn(deps({ intent: 'greeting' }, lk), turn('hi'))
    expect(g.reply.key).toBe('greeting')
    const u1 = await runSupportTurn(deps({ intent: 'other' }, lk), turn('asdf'))
    expect(u1.reply.key).toBe('unclear')
    expect(u1.unclearStreak).toBe(1)
    const u2 = await runSupportTurn(deps({ intent: 'other' }, lk, { settings: { escalateAfterTurns: 3, nudgeCooldownHours: 24 } }), turn('qwer', ['buyer'], { unclearStreak: 1 }))
    expect(u2.reply.key).toBe('unclear_again')
    expect(u2.unclearStreak).toBe(2)
    const u3 = await runSupportTurn(deps({ intent: 'other' }, lk), turn('zxcv', ['buyer'], { unclearStreak: 1 }))
    expect(u3.reply.key).toBe('escalated')
    expect(u3.escalate?.reason).toBe('unclear_twice')
  })
  it('"What can you help me with?" on an unclear turn → the capabilities template, not unclear; it never counts toward escalation', async () => {
    const lk = fakeLookups({})
    const a = await runSupportTurn(deps({ intent: 'other' }, lk), turn('What can you help me with?'))
    expect(a.reply.key).toBe('capabilities')
    expect(a.reply.text).toContain('person')
    expect(a.unclearStreak).toBe(0)
    expect(a.escalate).toBeUndefined()
    expect(a.numbers.ok).toBe(true)
    // after an unclear turn: still the capabilities answer, and the streak resets instead of escalating
    const b = await runSupportTurn(deps({ intent: 'other' }, lk), turn('what can you do', ['buyer'], { unclearStreak: 1 }))
    expect(b.reply.key).toBe('capabilities')
    expect(b.escalate).toBeUndefined()
    expect(b.unclearStreak).toBe(0)
    // a how-to with no topic gets the same answer; Hindi renders in Hindi
    const c = await runSupportTurn(deps({ intent: 'how_to', how_to_topic: 'other', language: 'hi' }, lk), { ...turn('आप क्या मदद कर सकते हैं?'), locale: 'hi' })
    expect(c.reply.key).toBe('capabilities')
    expect(c.reply.text).toContain('मदद')
  })
  it('the capabilities match never overrides a real intent or an escalation, and leaves real gibberish unclear', async () => {
    const lk = fakeLookups({ orders: [o(1, 'in_progress')] })
    const order = await runSupportTurn(deps({ intent: 'order_status', order_ref: 'latest' }, lk), turn('what can you tell me about my order'))
    expect(order.reply.key).toBe('order_status.in_progress')
    const esc = await runSupportTurn(deps({ intent: 'other', escalate: true, escalate_reason: 'asked_for_human', ops_summary: 'Wants a person.' }, lk), turn('what can you do, I want a person'))
    expect(esc.reply.key).toBe('escalated')
    const topic = await runSupportTurn(deps({ intent: 'how_to', how_to_topic: 'refund' }, lk), turn('how can you help with a refund'))
    expect(topic.reply.key).toBe('how_to.refund')
    const gib = await runSupportTurn(deps({ intent: 'other' }, lk), turn('asdf qwer'))
    expect(gib.reply.key).toBe('unclear')
  })
  it('complaint / dispute language / payment problem / explicit escalate → escalated with the reason and the ops summary', async () => {
    const lk = fakeLookups({ orders: [o(1, 'in_progress')] })
    for (const [intent, reason] of [['complaint', 'complaint'], ['dispute_language', 'dispute_language'], ['payment_problem', 'payment_problem']] as const) {
      const res = await runSupportTurn(deps({ intent, ops_summary: 'Buyer is unhappy with the delay.' }, lk), turn('this is unacceptable'))
      expect(res.reply.key).toBe('escalated')
      expect(res.escalate).toEqual({ reason, summary: 'Buyer is unhappy with the delay.' })
      expect(res.reply.text).toContain('24')
    }
    const h = await runSupportTurn(deps({ intent: 'other', escalate: true, escalate_reason: 'asked_for_human' }, lk), turn('I want a person'))
    expect(h.escalate?.reason).toBe('asked_for_human')
    expect(h.reply.key).toBe('escalated')
  })
  it('an open ticket → escalated_open, NO classification, no lookups', async () => {
    const lk = fakeLookups({ orders: [o(1, 'in_progress')] })
    let classified = 0
    const d = deps({ intent: 'order_status' }, lk)
    d.classify = async () => { classified++; return cls({ intent: 'order_status' }) }
    const res = await runSupportTurn(d, turn('where is my order', ['buyer'], {}, true))
    expect(res.reply.key).toBe('escalated_open')
    expect(classified).toBe(0)
    expect(lk.calls).toEqual([])
  })
  it('a classifier failure is an unclear turn, never a guess', async () => {
    const lk = fakeLookups({ orders: [o(1, 'in_progress')] })
    const d = deps({ intent: 'order_status' }, lk)
    d.classify = async () => { throw new Error('contract violation') }
    const res = await runSupportTurn(d, turn('where is my order'))
    expect(res.reply.key).toBe('unclear')
    expect(res.intent?.intent).toBe('other')
  })
  it('nudge_request with a subject → nudge.confirm + action; capped → nudge.capped; inactive → out_of_window; none → no_subject', async () => {
    const ok = await runSupportTurn(deps({ intent: 'nudge_request', order_ref: 'latest' }, fakeLookups({ orders: [o(1, 'accepted')] })), turn('remind the provider'))
    expect(ok.reply.key).toBe('nudge.confirm')
    expect(ok.action?.subject).toEqual({ kind: 'order', id: 'o1' })
    const capped = await runSupportTurn(deps({ intent: 'nudge_request', order_ref: 'latest' }, fakeLookups({ orders: [o(1, 'accepted')], capped: true })), turn('remind again'))
    expect(capped.reply.key).toBe('nudge.capped')
    expect(capped.reply.text).toContain('24')
    // the cap quoted is the setting, never a constant
    const capped12 = await runSupportTurn(deps({ intent: 'nudge_request', order_ref: 'latest' }, fakeLookups({ orders: [o(1, 'accepted')], capped: true }), { settings: { escalateAfterTurns: 2, nudgeCooldownHours: 12 } }), turn('remind again'))
    expect(capped12.reply.text).toContain('12')
    expect(capped12.reply.text).not.toContain('24 hours')
    expect(capped12.numbers.ok).toBe(true)
    const closed = await runSupportTurn(deps({ intent: 'nudge_request', rfq_ref: 'latest' }, fakeLookups({ rfqs: [r(1, 'expired')], active: false })), turn('remind providers'))
    expect(closed.reply.key).toBe('nudge.out_of_window')
    const none = await runSupportTurn(deps({ intent: 'nudge_request' }, fakeLookups({})), turn('remind them'))
    expect(none.reply.key).toBe('nudge.no_subject')
  })
  it('the numbers rule holds on every reply of a 12-turn scripted session (no digit outside the lookup payload / copy)', async () => {
    const lk = fakeLookups({ orders: [o(7, 'completed', { payout: { status: 'processing', scheduled_for: '30 Sep 2026', amount: '₹2,375' } }), o(6, 'refunded')], rfqs: [r(4, 'quoted', { quote_count: 3, my_quote: { status: 'accepted', price: '₹12,000' } })] })
    const script: Array<Partial<SupportIntentOutput>> = [
      { intent: 'greeting' }, { intent: 'order_status', order_ref: 'latest' }, { intent: 'order_status', order_ref: 'AMC-2026-000126' }, { intent: 'payment_status', order_ref: 'AMC-2026-000126' },
      { intent: 'payout_status', order_ref: 'latest', as_role: 'provider' }, { intent: 'rfq_status', rfq_ref: 'latest' }, { intent: 'quote_status', rfq_ref: 'Request 4', as_role: 'provider' }, { intent: 'how_to', how_to_topic: 'refund' },
      { intent: 'how_to', how_to_topic: 'payout_timing' }, { intent: 'nudge_request', order_ref: 'latest' }, { intent: 'how_to', how_to_topic: 'contact_human' }, { intent: 'other' },
    ]
    for (const [i, s] of script.entries()) {
      const res = await runSupportTurn(deps(s, lk), turn(`turn ${i}`, ['buyer', 'provider']))
      expect(res.numbers.ok, `${res.reply.key}: ${res.numbers.missing.join(',')}`).toBe(true)
      expect(res.reply.text).not.toMatch(/[{}]/)
    }
  })
  it('renders in the user locale', async () => {
    const lk = fakeLookups({ orders: [o(1, 'in_progress')] })
    const res = await runSupportTurn(deps({ intent: 'order_status', order_ref: 'latest', language: 'hi' }, lk), { ...turn('mera order kahan hai'), locale: 'hi' })
    expect(res.reply.text).toContain('प्रगति में')
    expect(res.reply.text).toContain('AMC-2026-000121')
  })
})
