import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mayMessage,
  resetWaSendStateForTests,
  sendWhatsApp,
  waCircuitState,
  type SendResult,
  type WaGraphError,
  type WaSendRequest,
  type WhatsAppProvider,
} from './index'
import { fakeDb, type FakeDbOptions } from './testing/fake-db'

/**
 * ADR-030 §2–§3 — the one send path: consent, STOP, suppression, the window, the ledger row before the call, the
 * idempotency key, Graph error handling and the pre-0086 fallback.
 */

const NOW = new Date('2026-10-02T10:00:00Z')
const PHONE = '919876543210'
const OPEN = new Date(NOW.getTime() + 6 * 3600 * 1000).toISOString() // window open for 6 more hours
const CLOSED = new Date(NOW.getTime() - 3600 * 1000).toISOString()
const UNIQUE: FakeDbOptions['unique'] = { wa_messages: ['idempotency_key', 'vendor_message_id'], wa_conversations: ['phone_e164'] }

type Planned = Partial<SendResult> | ((method: string) => Partial<SendResult>)
function provider(plan: Planned[] = []) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  let n = 0
  const respond = async (method: string, args: unknown[]): Promise<SendResult> => {
    calls.push({ method, args })
    const p = plan[n++]
    const r = typeof p === 'function' ? p(method) : p
    return { ok: true, vendorMessageId: `wamid.OUT${n}`, detail: 'sent', ...(r ?? {}) }
  }
  const p = {
    name: 'meta_cloud',
    sendTemplate: (...args: unknown[]) => respond('template', args),
    sendText: (...args: unknown[]) => respond('text', args),
    sendButtons: (...args: unknown[]) => respond('buttons', args),
    sendCtaUrl: (...args: unknown[]) => respond('cta_url', args),
    sendMedia: (...args: unknown[]) => respond('media', args),
    markRead: async () => ({ ok: true, vendorMessageId: null, detail: 'read' }),
  } as unknown as WhatsAppProvider
  return { p, calls }
}
const graphFail = (code: number, httpStatus = 400): Partial<SendResult> => ({ ok: false, vendorMessageId: null, detail: `error:${code}`, error: { code, subcode: null, title: `err ${code}`, message: `err ${code}`, httpStatus } as WaGraphError })

function seed(opts: { window?: string | null; consents?: Array<[string, 'opted_in' | 'opted_out']>; suppression?: { reason: string; until: string | null } | null; extra?: Record<string, Record<string, unknown>[]> } = {}) {
  return {
    wa_conversations: [{ id: 'conv1', phone_e164: PHONE, user_id: 'u1', locale: 'en', window_open_until: opts.window === undefined ? OPEN : opts.window }],
    wa_messages: [],
    // updated_at before the fake clock's created_at stamps (the opt-out confirmation is "once since the latest STOP")
    wa_phone_consents: (opts.consents ?? []).map(([purpose, status]) => ({ phone_e164: PHONE, purpose, status, updated_at: '2026-09-25T00:00:00.000Z' })),
    wa_suppressions: opts.suppression ? [{ phone_e164: PHONE, ...opts.suppression }] : [],
    wa_templates: [],
    ...(opts.extra ?? {}),
  }
}

const notice = (over: Partial<WaSendRequest> = {}): WaSendRequest => ({
  phoneE164: `+${PHONE}`,
  userId: 'u1',
  purpose: 'transactional',
  initiation: 'business',
  kind: 'order_accepted',
  body: { type: 'template', kind: 'order_accepted', locale: 'te', values: { title: 'Order AMC-1 accepted', body: 'Lakshmi Tax accepted it.', link: '/app/orders/o1' } },
  idempotencyKey: 'n1:whatsapp',
  notificationId: '00000000-0000-0000-0000-0000000000n1',
  ...over,
})
const reply = (over: Partial<WaSendRequest> = {}): WaSendRequest => ({
  phoneE164: PHONE,
  conversationId: 'conv1',
  userId: 'u1',
  purpose: 'assistant',
  initiation: 'reply',
  kind: 'support_reply',
  body: { type: 'text', text: 'Your order is in progress.' },
  fallbackTemplate: { type: 'template', kind: 'support_reply', locale: 'en', values: { title: 'Your order', body: 'Your order is in progress.' } },
  idempotencyKey: 'in1:reply:1',
  meta: { run_id: 'run-1' },
  ...over,
})
const settings = async () => 120

beforeEach(() => {
  resetWaSendStateForTests()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('consent (ADR-030 §2)', () => {
  it('business-initiated without an opt-in → skipped no_consent, nothing sent, no row', async () => {
    const db = fakeDb(seed(), { unique: UNIQUE })
    const { p, calls } = provider()
    const r = await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, notice())
    expect(r).toEqual({ outcome: 'skipped', reason: 'no_consent' })
    expect(calls).toHaveLength(0)
    expect(db.tables['wa_messages']).toHaveLength(0)
  })
  it('opted in → the te template goes under the te language, with the ledger row written first and completed after', async () => {
    const db = fakeDb(seed({ consents: [['transactional', 'opted_in']] }), { unique: UNIQUE })
    const { p, calls } = provider()
    const r = await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, notice())
    expect(r).toMatchObject({ outcome: 'sent', vendorMessageId: 'wamid.OUT1', usedTemplate: true, attempt: 1 })
    expect(calls[0]!.args[1]).toEqual({ name: 'amc_order_accepted_te', language: 'te' })
    expect(calls[0]!.args[2]).toMatchObject({ body: ['Order AMC-1 accepted', 'Lakshmi Tax accepted it.'], urlButton: { suffix: 'app/orders/o1' } })
    const row = db.tables['wa_messages']![0]!
    expect(row).toMatchObject({
      id: r.messageId, conversation_id: 'conv1', direction: 'out', kind: 'template', status: 'sent', vendor_message_id: 'wamid.OUT1',
      idempotency_key: 'n1:whatsapp', user_id: 'u1', notification_kind: 'order_accepted', template_name: 'amc_order_accepted_te',
      template_language: 'te', category: 'utility', error_code: null,
    })
    expect(db.calls.filter((c) => c.table === 'wa_messages').map((c) => c.op)).toEqual(['insert', 'update'])
    expect(db.tables['wa_conversations']![0]!['last_outbound_at']).toBe(NOW.toISOString())
  })
  it('STOP (every purpose opted out) → nothing, business or reply', async () => {
    const stopped: Array<[string, 'opted_out']> = [['transactional', 'opted_out'], ['assistant', 'opted_out'], ['marketing', 'opted_out']]
    const db = fakeDb(seed({ consents: stopped }), { unique: UNIQUE })
    const { p, calls } = provider()
    expect(await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, notice())).toMatchObject({ outcome: 'skipped', reason: 'opted_out' })
    expect(await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, reply())).toMatchObject({ outcome: 'skipped', reason: 'opted_out' })
    expect(calls).toHaveLength(0)
  })
  it('the opt-out confirmation still goes, once per STOP', async () => {
    const stopped: Array<[string, 'opted_out']> = [['transactional', 'opted_out'], ['assistant', 'opted_out'], ['marketing', 'opted_out']]
    const db = fakeDb(seed({ consents: stopped }), { unique: UNIQUE })
    const { p, calls } = provider()
    const conf = (key: string): WaSendRequest => ({ phoneE164: PHONE, conversationId: 'conv1', userId: 'u1', purpose: 'transactional', initiation: 'reply', kind: 'wa_opt_out_confirmed', body: { type: 'text', text: 'You will get no more WhatsApp messages from AMClub.' }, idempotencyKey: key })
    const first = await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, conf('stop-msg-1:confirm'))
    expect(first.outcome).toBe('sent')
    const again = await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, conf('stop-msg-1b:confirm'))
    expect(again).toMatchObject({ outcome: 'skipped', reason: 'opted_out' })
    expect(calls).toHaveLength(1)
  })
  it('a reply inside the window needs no opt-in; the same reply after the window is business and needs one', async () => {
    const db = fakeDb(seed(), { unique: UNIQUE })
    const { p } = provider()
    expect(await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, reply())).toMatchObject({ outcome: 'sent', usedTemplate: false })
    const closed = fakeDb(seed({ window: CLOSED }), { unique: UNIQUE })
    expect(await sendWhatsApp({ db: closed.client, provider: p, now: () => NOW, settings }, reply())).toMatchObject({ outcome: 'skipped', reason: 'no_consent' })
  })
  it('an assistant-only opt-out does not block a reply; a business send for that purpose is opted_out', async () => {
    const db = fakeDb(seed({ consents: [['transactional', 'opted_in'], ['assistant', 'opted_out']] }), { unique: UNIQUE })
    expect(await mayMessage(db.client, PHONE, 'assistant', 'reply', { now: NOW })).toEqual({ ok: true })
    expect(await mayMessage(db.client, PHONE, 'assistant', 'business', { now: NOW })).toEqual({ ok: false, reason: 'opted_out' })
    expect(await mayMessage(db.client, PHONE, 'transactional', 'business', { now: NOW })).toEqual({ ok: true })
    expect(await mayMessage(db.client, PHONE, 'marketing', 'reply', { now: NOW })).toEqual({ ok: false, reason: 'no_consent' })
  })
  it('a business-scoped id is never a phone', async () => {
    const db = fakeDb(seed(), { unique: UNIQUE })
    expect(await sendWhatsApp({ db: db.client, provider: provider().p, now: () => NOW, settings }, notice({ phoneE164: 'IN.919876543210' }))).toEqual({ outcome: 'skipped', reason: 'bad_phone' })
  })
})

describe('suppression', () => {
  it('not_on_whatsapp blocks every purpose until it expires; marketing_stopped blocks marketing only', async () => {
    const live = fakeDb(seed({ consents: [['transactional', 'opted_in'], ['marketing', 'opted_in']], suppression: { reason: 'not_on_whatsapp', until: '2026-10-30T00:00:00Z' } }))
    expect(await mayMessage(live.client, PHONE, 'transactional', 'business', { now: NOW })).toEqual({ ok: false, reason: 'suppressed' })
    const expired = fakeDb(seed({ consents: [['transactional', 'opted_in']], suppression: { reason: 'not_on_whatsapp', until: '2026-09-01T00:00:00Z' } }))
    expect(await mayMessage(expired.client, PHONE, 'transactional', 'business', { now: NOW })).toEqual({ ok: true })
    const mkt = fakeDb(seed({ consents: [['transactional', 'opted_in'], ['marketing', 'opted_in']], suppression: { reason: 'marketing_stopped', until: null } }))
    expect(await mayMessage(mkt.client, PHONE, 'transactional', 'business', { now: NOW })).toEqual({ ok: true })
    expect(await mayMessage(mkt.client, PHONE, 'marketing', 'business', { now: NOW })).toEqual({ ok: false, reason: 'suppressed' })
  })
  it('131026 (not on WhatsApp) records a 30-day suppression and the next send is skipped', async () => {
    const db = fakeDb(seed({ consents: [['transactional', 'opted_in']] }), { unique: UNIQUE })
    const { p, calls } = provider([graphFail(131026)])
    const r = await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, notice())
    expect(r).toMatchObject({ outcome: 'failed', error: { code: 131026, kind: 'not_on_whatsapp', retryable: false } })
    expect(db.tables['wa_suppressions']![0]).toMatchObject({ phone_e164: PHONE, reason: 'not_on_whatsapp', error_code: 131026, until: '2026-11-01T10:00:00.000Z' })
    expect(db.tables['wa_messages']![0]).toMatchObject({ status: 'failed', error_code: 131026 })
    expect(await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, notice({ idempotencyKey: 'n2:whatsapp' }))).toMatchObject({ outcome: 'skipped', reason: 'suppressed' })
    expect(calls).toHaveLength(1)
  })
  it('131050 (stopped marketing) records marketing_stopped for 90 days', async () => {
    const db = fakeDb(seed({ consents: [['transactional', 'opted_in']] }), { unique: UNIQUE })
    await sendWhatsApp({ db: db.client, provider: provider([graphFail(131050)]).p, now: () => NOW, settings }, notice())
    expect(db.tables['wa_suppressions']![0]).toMatchObject({ reason: 'marketing_stopped', until: '2026-12-31T10:00:00.000Z' })
  })
  it('131049 (marketing limit) fails without a suppression and is not retryable', async () => {
    const db = fakeDb(seed({ consents: [['transactional', 'opted_in']] }), { unique: UNIQUE })
    const r = await sendWhatsApp({ db: db.client, provider: provider([graphFail(131049)]).p, now: () => NOW, settings }, notice())
    expect(r.error).toMatchObject({ kind: 'marketing_limit', retryable: false })
    expect(db.tables['wa_suppressions']).toHaveLength(0)
  })
})

describe('the 24-hour window', () => {
  it('outside the window: the fallback template goes (with fallbackMeta), or nothing (outside_window)', async () => {
    const db = fakeDb(seed({ window: CLOSED, consents: [['assistant', 'opted_in']] }), { unique: UNIQUE })
    const { p, calls } = provider()
    const r = await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, reply({ initiation: 'business', fallbackMeta: { nudge_offer: true } }))
    expect(r).toMatchObject({ outcome: 'sent', usedTemplate: true })
    expect(calls[0]!.method).toBe('template')
    expect(db.tables['wa_messages']![0]!['payload']).toMatchObject({ nudge_offer: true, template_name: 'amc_support_reply_en' })
    expect((db.tables['wa_messages']![0]!['payload'] as Record<string, unknown>)['run_id']).toBeUndefined()
    const noFallback: WaSendRequest = { ...reply({ initiation: 'business', idempotencyKey: 'k2' }) }
    delete noFallback.fallbackTemplate
    expect(await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, noFallback)).toEqual({ outcome: 'skipped', reason: 'outside_window' })
  })
  it('the margin: a window closing in 60 s is treated as closed (default 120 s)', async () => {
    const db = fakeDb(seed({ window: new Date(NOW.getTime() + 60_000).toISOString(), consents: [['assistant', 'opted_in']] }), { unique: UNIQUE })
    const { p, calls } = provider()
    await sendWhatsApp({ db: db.client, provider: p, now: () => NOW }, reply({ initiation: 'business' }))
    expect(calls[0]!.method).toBe('template')
    const wide = fakeDb(seed({ window: new Date(NOW.getTime() + 60_000).toISOString(), consents: [['assistant', 'opted_in']] }), { unique: UNIQUE })
    const q = provider()
    await sendWhatsApp({ db: wide.client, provider: q.p, now: () => NOW, settings: async () => 0 }, reply({ initiation: 'business' }))
    expect(q.calls[0]!.method).toBe('text')
  })
  it('131047 from Meta (the window closed after all) → retried ONCE as the fallback template on the same row', async () => {
    const db = fakeDb(seed({ consents: [['assistant', 'opted_in']] }), { unique: UNIQUE })
    const { p, calls } = provider([graphFail(131047), {}])
    const r = await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, reply())
    expect(r).toMatchObject({ outcome: 'sent', usedTemplate: true })
    expect(calls.map((c) => c.method)).toEqual(['text', 'template'])
    expect(db.tables['wa_messages']).toHaveLength(1)
    expect(db.tables['wa_messages']![0]).toMatchObject({ kind: 'template', template_name: 'amc_support_reply_en', status: 'sent' })
  })
  it('a template Meta paused or re-categorised is refused before sending', async () => {
    const db = fakeDb(seed({ consents: [['transactional', 'opted_in']], extra: { wa_templates: [{ name: 'amc_order_accepted_te', language: 'te', status: 'paused', category: 'utility' }] } }), { unique: UNIQUE })
    expect(await sendWhatsApp({ db: db.client, provider: provider().p, now: () => NOW, settings }, notice())).toEqual({ outcome: 'skipped', reason: 'template_not_approved' })
    const recat = fakeDb(seed({ consents: [['transactional', 'opted_in']], extra: { wa_templates: [{ name: 'amc_order_accepted_te', language: 'te', status: 'approved', category: 'marketing' }] } }), { unique: UNIQUE })
    expect(await sendWhatsApp({ db: recat.client, provider: provider().p, now: () => NOW, settings }, notice())).toEqual({ outcome: 'skipped', reason: 'template_not_approved' })
  })
})

describe('idempotency and retries', () => {
  it('the same key twice → duplicate; the vendor is called once', async () => {
    const db = fakeDb(seed({ consents: [['transactional', 'opted_in']] }), { unique: UNIQUE })
    const { p, calls } = provider()
    const a = await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, notice())
    const b = await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, notice())
    expect(b).toEqual({ outcome: 'duplicate', messageId: a.messageId })
    expect(calls).toHaveLength(1)
  })
  it('a retryable failure (rate limit) is re-sent on the same row under the same key; a permanent one is not', async () => {
    const db = fakeDb(seed({ consents: [['transactional', 'opted_in']] }), { unique: UNIQUE })
    const { p, calls } = provider([graphFail(130429), {}])
    const first = await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, notice())
    expect(first).toMatchObject({ outcome: 'failed', error: { kind: 'rate_limited', retryable: true } })
    const second = await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, notice())
    expect(second).toMatchObject({ outcome: 'sent', attempt: 2, messageId: first.messageId })
    expect(calls).toHaveLength(2)
    expect(db.tables['wa_messages']).toHaveLength(1)
    const third = await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, notice())
    expect(third.outcome).toBe('duplicate')
    const perm = fakeDb(seed({ consents: [['transactional', 'opted_in']] }), { unique: UNIQUE })
    const q = provider([graphFail(132001, 404), {}])
    await sendWhatsApp({ db: perm.client, provider: q.p, now: () => NOW, settings }, notice())
    expect((await sendWhatsApp({ db: perm.client, provider: q.p, now: () => NOW, settings }, notice())).outcome).toBe('duplicate')
    expect(q.calls).toHaveLength(1)
  })
  it('an account restriction (368) opens the circuit: further sends fail fast without calling Meta', async () => {
    const db = fakeDb(seed({ consents: [['transactional', 'opted_in']] }), { unique: UNIQUE })
    const { p, calls } = provider([graphFail(368, 403)])
    const r = await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, notice())
    expect(r.error).toMatchObject({ code: 368, kind: 'account_restricted', retryable: false })
    expect(waCircuitState(NOW).open).toBe(true)
    const next = await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, notice({ idempotencyKey: 'n9:whatsapp' }))
    expect(next).toMatchObject({ outcome: 'failed', error: { kind: 'account_restricted', title: 'circuit_open' } })
    expect(calls).toHaveLength(1)
    const later = new Date(NOW.getTime() + 11 * 60_000)
    expect(waCircuitState(later).open).toBe(false)
  })
  it('the stub driver records the row as stub', async () => {
    const db = fakeDb(seed({ consents: [['transactional', 'opted_in']] }), { unique: UNIQUE })
    const { p } = provider([{ vendorMessageId: null, detail: 'stub' }])
    expect(await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, notice())).toMatchObject({ outcome: 'stub' })
    expect(db.tables['wa_messages']![0]).toMatchObject({ status: 'stub' })
  })
  it('a phone with no conversation yet gets one (bound to the recipient) and the row belongs to it', async () => {
    const db = fakeDb({ wa_conversations: [], wa_messages: [], wa_phone_consents: [{ phone_e164: '919000000001', purpose: 'transactional', status: 'opted_in' }], wa_suppressions: [] }, { unique: UNIQUE })
    const r = await sendWhatsApp({ db: db.client, provider: provider().p, now: () => NOW, settings }, notice({ phoneE164: '+91 90000 00001', userId: 'u7' }))
    expect(r.outcome).toBe('sent')
    expect(db.tables['wa_conversations']![0]).toMatchObject({ phone_e164: '919000000001', user_id: 'u7', locale: 'te' })
    expect(db.tables['wa_messages']![0]!['conversation_id']).toBe(db.tables['wa_conversations']![0]!['id'])
  })
})

describe('before migration 0086 (fallback to the pre-ADR-030 rule)', () => {
  const missing: FakeDbOptions = {
    unique: UNIQUE,
    missingTables: ['wa_phone_consents', 'wa_suppressions', 'wa_templates'],
    missingColumns: { wa_messages: ['idempotency_key', 'user_id', 'notification_kind', 'notification_id', 'run_id', 'template_language', 'category', 'status_at', 'error_code', 'error_title'] },
  }
  it('order / payment kinds send without a grant, and the row is written the old way after the call', async () => {
    const db = fakeDb(seed(), missing)
    const { p, calls } = provider()
    const r = await sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, notice())
    expect(r).toMatchObject({ outcome: 'sent' })
    expect(calls).toHaveLength(1)
    const row = db.tables['wa_messages']![0]!
    expect(row).toMatchObject({ direction: 'out', kind: 'template', status: 'sent', template_name: 'amc_order_accepted_te', vendor_message_id: 'wamid.OUT1' })
    expect('idempotency_key' in row).toBe(false)
  })
  it('any other business kind needs an active WhatsApp grant from this phone', async () => {
    const db = fakeDb(seed(), missing)
    const req = notice({ kind: 'rfq_matched', body: { type: 'template', kind: 'rfq_matched', locale: 'en', values: { title: 't', body: 'b' } } })
    expect(await sendWhatsApp({ db: db.client, provider: provider().p, now: () => NOW, settings }, req)).toMatchObject({ outcome: 'skipped', reason: 'no_consent' })
    const granted = fakeDb(seed({ extra: { agent_grants: [{ id: 'g1', user_id: 'u1', channel: 'whatsapp', channel_identity: `+${PHONE}`, revoked_at: null }] } }), missing)
    expect(await sendWhatsApp({ db: granted.client, provider: provider().p, now: () => NOW, settings }, req)).toMatchObject({ outcome: 'sent' })
    const otherPhone = fakeDb(seed({ extra: { agent_grants: [{ id: 'g1', user_id: 'u1', channel: 'whatsapp', channel_identity: '+919999999999', revoked_at: null }] } }), missing)
    expect(await sendWhatsApp({ db: otherPhone.client, provider: provider().p, now: () => NOW, settings }, { ...req, idempotencyKey: 'x' })).toMatchObject({ outcome: 'skipped', reason: 'no_consent' })
  })
  it('replies inside the window still go; marketing never does', async () => {
    const db = fakeDb(seed(), missing)
    expect(await sendWhatsApp({ db: db.client, provider: provider().p, now: () => NOW, settings }, reply())).toMatchObject({ outcome: 'sent' })
    expect(await mayMessage(db.client, PHONE, 'marketing', 'business', { now: NOW })).toEqual({ ok: false, reason: 'no_consent' })
  })
})
