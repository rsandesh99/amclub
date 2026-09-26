import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WA_MENU_KNOWN, WA_MENU_UNKNOWN, waMenuPayload } from '@amclub/shared'
import { fakeDb, type FakeDb } from '../testing/fake-db'
import { handleWaInbound, inboundSentAt, systemIntentOf, type InboundHooks } from './inbound'
import { isStopped, needsRebindConfirmation, personasForRoles } from './consent'
import type { SendSystemFn } from './menu'

/**
 * ADR-030 §2 — the dispatcher's decisions (audit B1 / B3 / B4 / B8): the HELP menu for everyone without a model, STOP
 * for every purpose and every grant (even from an unknown number), nothing after STOP but a later START, greetings and
 * "no" / "cancel" never consent, a BSUID-only sender, dormant / recycled numbers, the language switch.
 */

const NOW = new Date('2026-09-26T12:00:00Z')
const PHONE = '919800000001'
const U = 'user-1'
const RECENT = new Date(NOW.getTime() - 2 * 86400_000).toISOString()

type Row = Record<string, unknown>

function world(extra: Record<string, Row[]> = {}, user: Row = {}): FakeDb {
  return fakeDb({
    users: [{ id: U, phone: `+${PHONE}`, preferred_locale: 'en', roles: ['msme', 'provider'], created_at: RECENT, last_seen_at: RECENT, ...user }],
    wa_conversations: [{ id: 'c1', phone_e164: PHONE, user_id: U, locale: 'en', last_holding_reply_at: null, active_session_id: null, support_ticket_id: null, procurement_session_id: null }],
    ...extra,
  })
}

/** record_wa_consent as 0086 writes it: an event per purpose, the current state, the number of purposes that changed. */
function consentRpc(db: FakeDb, opts: { missing?: boolean } = {}) {
  const calls: Row[] = []
  ;(db.client as unknown as { rpc: unknown }).rpc = async (fn: string, args: Row) => {
    calls.push({ fn, ...args })
    if (opts.missing) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.record_wa_consent' } }
    const status = args['p_action'] === 'opt_in' ? 'opted_in' : 'opted_out'
    let changed = 0
    for (const purpose of args['p_purposes'] as string[]) {
      ;(db.tables['wa_consent_events'] ??= []).push({ phone_e164: args['p_phone'], user_id: args['p_user_id'], purpose, action: args['p_action'], source: args['p_source'], keyword: args['p_keyword'], vendor_message_id: args['p_vendor_message_id'], notice_version: args['p_notice_version'] })
      const rows = (db.tables['wa_phone_consents'] ??= [])
      const cur = rows.find((r) => r['phone_e164'] === args['p_phone'] && r['purpose'] === purpose)
      if (cur?.['status'] !== status) changed++
      if (cur) cur['status'] = status
      else rows.push({ phone_e164: args['p_phone'], purpose, status, user_id: args['p_user_id'] })
    }
    return { data: changed, error: null }
  }
  return calls
}

/** Tables that do not exist yet (0086 / 0087 not applied): every query answers 42P01. */
function missingTables(db: FakeDb, tables: string[]): void {
  const from = db.client.from.bind(db.client)
  const missing = (): unknown => {
    const result = { data: null, error: { code: '42P01', message: 'relation does not exist' } }
    const b: Record<string, unknown> = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve(res(result))
        if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve(result)
        return () => b
      },
    })
    return b
  }
  ;(db.client as unknown as { from: (t: string) => unknown }).from = (t: string) => (tables.includes(t) ? missing() : from(t))
}

interface Sent { kind: string; locale: string; text: string | undefined; buttons: string[]; key: string }

function harness(db: FakeDb, over: { agentEnabled?: boolean; now?: Date } = {}) {
  const sent: Sent[] = []
  const events: Array<{ id: string; event: string; props: Row }> = []
  const send = (async (_conv: unknown, kind: string, locale: string, opts: { idempotencyKey: string; text?: string; buttons?: Array<{ id: string }> }) => {
    sent.push({ kind, locale, text: opts.text, buttons: (opts.buttons ?? []).map((b) => b.id), key: opts.idempotencyKey })
    return { outcome: 'stub' }
  }) as unknown as SendSystemFn
  let seq = 0
  const say = async (msg: { body?: string; button?: string; kind?: string; payload?: Row; at?: Date }, hooks: InboundHooks = {}) => {
    const id = `m${++seq}`
    const at = msg.at ?? NOW
    const kind = msg.kind ?? (msg.button !== undefined ? 'button' : 'text')
    const payload: Row = { timestamp: String(Math.floor(at.getTime() / 1000)), ...(msg.button !== undefined ? { interactive: { button_reply: { id: msg.button } } } : {}), ...(msg.payload ?? {}) }
    ;(db.tables['wa_messages'] ??= []).push({ id, conversation_id: (db.tables['wa_conversations']![0]!['id'] as string), direction: 'in', vendor_message_id: `wamid.${id}`, kind, body: msg.body ?? null, payload, media_ref: null, mime: null, created_at: at.toISOString(), processed_at: null })
    await handleWaInbound(id, hooks, { db: db.client, send, now: () => over.now ?? NOW, agentEnabled: over.agentEnabled ?? true, capture: (i, e, p) => events.push({ id: i, event: e, props: p ?? {} }), ledger: null })
    return id
  }
  return { sent, events, say }
}

const kinds = (s: Sent[]) => s.map((x) => x.kind)

// ── pure ──────────────────────────────────────────────────────────────────────

test('keywords and payloads: greetings are not consent, no / cancel are not STOP, buttons by payload id', () => {
  assert.equal(systemIntentOf({ kind: 'text', body: 'STOP', payload: null })?.intent, 'stop')
  assert.equal(systemIntentOf({ kind: 'text', body: 'बंद करो', payload: null })?.intent, 'stop')
  assert.equal(systemIntentOf({ kind: 'text', body: 'hi', payload: null })?.intent, 'greeting')
  assert.equal(systemIntentOf({ kind: 'text', body: 'no', payload: null }), null)
  assert.equal(systemIntentOf({ kind: 'text', body: 'cancel', payload: null }), null)
  const btn = (id: string) => ({ kind: 'button', body: 'No', payload: { interactive: { button_reply: { id } } } })
  assert.equal(systemIntentOf(btn('wa:start'))?.intent, 'start')
  assert.equal(systemIntentOf(btn('wa:stop'))?.keyword, 'button:wa:stop')
  assert.equal(systemIntentOf(btn('wa:menu:stop'))?.intent, 'stop')
  assert.deepEqual(systemIntentOf(btn('wa:menu:track')), { intent: 'menu_item', source: 'button', keyword: 'button:wa:menu:track', item: 'track' })
  assert.equal(systemIntentOf(btn('wa:lang:te'))?.locale, 'te')
  assert.equal(systemIntentOf(btn('STOP'))?.intent, 'stop', 'a template quick reply whose payload IS the keyword')
  assert.equal(systemIntentOf(btn('nudge:no:7f3a2100-0000-4000-8000-000000000000')), null, 'the nudge offer\'s "No" is never STOP')
  assert.equal(systemIntentOf({ kind: 'text', body: 'Telugu', payload: null })?.locale, 'te')
})

test('personas, stop state, rebind rule, send time', () => {
  assert.deepEqual(personasForRoles(['msme', 'provider']), ['buyer', 'provider'])
  assert.deepEqual(personasForRoles(['provider']), ['provider'])
  assert.deepEqual(personasForRoles(['msme', 'admin', 'ops']), ['buyer'])
  assert.equal(isStopped({ transactional: 'opted_out', assistant: 'opted_out', marketing: 'none' }), true)
  assert.equal(isStopped({ transactional: 'opted_out', assistant: 'opted_in', marketing: 'none' }), false)
  const day = 86400_000
  assert.equal(needsRebindConfirmation({ lastSeenAt: new Date(NOW.getTime() - 91 * day).toISOString(), createdAt: null }, NOW, 90), true)
  assert.equal(needsRebindConfirmation({ lastSeenAt: new Date(NOW.getTime() - 89 * day).toISOString(), createdAt: null }, NOW, 90), false)
  assert.equal(needsRebindConfirmation({ lastSeenAt: null, createdAt: new Date(NOW.getTime() - 200 * day).toISOString() }, NOW, 90), true)
  assert.equal(needsRebindConfirmation({ lastSeenAt: new Date(NOW.getTime() - 400 * day).toISOString(), createdAt: null }, NOW, 0), false, '0 = off')
  assert.equal(needsRebindConfirmation({ lastSeenAt: RECENT, createdAt: null }, NOW, 90, NOW.toISOString()), true, 'the number changed after the last sign-in')
  assert.equal(inboundSentAt({ payload: { timestamp: '1790000000' }, created_at: null })?.toISOString(), new Date(1790000000 * 1000).toISOString())
})

// ── the menu ─────────────────────────────────────────────────────────────────

test('a bound user the Support agent does not serve: any text → the menu (five items), no model, nothing enqueued', async () => {
  const db = world()
  consentRpc(db)
  const h = harness(db)
  let enqueued = 0
  const hooks: InboundHooks = { enqueueSupportReply: async () => (enqueued++, 'q'), enqueueSupportDecide: async () => (enqueued++, 'q') }
  await h.say({ body: 'where is my order?' }, hooks)
  assert.deepEqual(kinds(h.sent), ['wa_menu'])
  assert.deepEqual(h.sent[0]!.buttons, WA_MENU_KNOWN.map(waMenuPayload))
  assert.equal(enqueued, 0)
  // unsolicited menus are spaced: a second free text a minute later gets nothing; HELP always answers
  await h.say({ body: 'hello??? anyone' }, hooks)
  assert.deepEqual(kinds(h.sent), ['wa_menu'])
  await h.say({ body: 'MENU' }, hooks)
  assert.deepEqual(kinds(h.sent), ['wa_menu', 'wa_menu'])
})

test('"hi" is never consent: no consent event, no grant — the menu', async () => {
  const db = world({ agent_grants: [] })
  const calls = consentRpc(db)
  const h = harness(db)
  await h.say({ body: 'hi' })
  assert.equal(calls.length, 0)
  assert.equal((db.tables['agent_grants'] ?? []).length, 0)
  assert.deepEqual(kinds(h.sent), ['wa_menu'])
})

test('an unknown number: the menu offers only Language, How to sign up, Talk to a person, Stop', async () => {
  const db = world()
  db.tables['wa_conversations']![0]!['user_id'] = null
  db.tables['users'] = []
  consentRpc(db)
  const h = harness(db)
  await h.say({ body: 'hello' })
  assert.deepEqual(h.sent[0]!.buttons, WA_MENU_UNKNOWN.map(waMenuPayload))
  // "track" from an unknown number is never an account read: the unknown menu again
  await h.say({ button: 'wa:menu:track' })
  assert.deepEqual(h.sent[1]!.buttons, WA_MENU_UNKNOWN.map(waMenuPayload))
  // talk to a person: the contact line (no account → no ticket)
  await h.say({ button: 'wa:menu:human' })
  assert.equal(h.sent[2]!.kind, 'wa_human')
  assert.match(h.sent[2]!.text ?? '', /support@amclub\.in/)
  assert.equal((db.tables['support_tickets'] ?? []).length, 0)
})

// ── STOP / START ─────────────────────────────────────────────────────────────

function stopWorld() {
  return world({
    agent_grants: [
      { id: 'g-b', user_id: U, persona: 'buyer', channel: 'whatsapp', channel_identity: `+${PHONE}`, scopes: ['support_lookup'], revoked_at: null },
      { id: 'g-p', user_id: U, persona: 'provider', channel: 'whatsapp', channel_identity: `+${PHONE}`, scopes: ['submit_quote'], revoked_at: null },
      { id: 'g-web', user_id: U, persona: 'provider', channel: 'web', channel_identity: null, scopes: ['submit_quote'], revoked_at: null },
    ],
    munshi_drafts: [{ id: 'd1', user_id: U, status: 'proposed', run_id: null, delivered: { whatsapp: 'out-1' }, deleted_at: null }],
    procurement_sessions: [{ id: 'ps1', user_id: U, conversation_id: 'c1', state: 'drafting', open_run_id: null, deleted_at: null }],
  })
}

test('STOP: opt-out for all three purposes (the real keyword + message id), every WhatsApp grant revoked, work halted, one confirmation', async () => {
  const db = stopWorld()
  Object.assign(db.tables['wa_conversations']![0]!, { active_session_id: 'onb-1', support_ticket_id: 'tick-1', procurement_session_id: 'ps1' })
  const calls = consentRpc(db)
  const h = harness(db)
  const id = await h.say({ body: 'Stop please' })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!['p_purposes'], ['transactional', 'assistant', 'marketing'])
  assert.equal(calls[0]!['p_action'], 'opt_out')
  assert.equal(calls[0]!['p_source'], 'whatsapp_keyword')
  assert.equal(calls[0]!['p_keyword'], 'Stop please')
  assert.equal(calls[0]!['p_vendor_message_id'], `wamid.${id}`)
  assert.equal(calls[0]!['p_user_id'], U)
  const grants = Object.fromEntries(db.tables['agent_grants']!.map((g) => [g['id'], g['revoked_at']]))
  assert.ok(grants['g-b'] && grants['g-p'], 'both WhatsApp personas revoked')
  assert.equal(grants['g-web'], null, 'the web grant stays')
  const conv = db.tables['wa_conversations']![0]!
  assert.deepEqual([conv['active_session_id'], conv['support_ticket_id'], conv['procurement_session_id']], [null, null, null])
  assert.equal(db.tables['munshi_drafts']![0]!['status'], 'expired')
  assert.equal(db.tables['procurement_sessions']![0]!['state'], 'failed')
  assert.deepEqual(kinds(h.sent), ['wa_opt_out_confirmed'])
  assert.deepEqual(h.sent[0]!.buttons, ['wa:start'])

  // after STOP: nothing (no menu, no model) …
  let enqueued = 0
  await h.say({ body: 'hi' }, { enqueueSupportReply: async () => (enqueued++, 'q') })
  await h.say({ body: 'where is my order' })
  // … a second STOP is recorded but not confirmed again
  await h.say({ body: 'STOP' })
  assert.equal(calls.length, 2)
  assert.deepEqual(kinds(h.sent), ['wa_opt_out_confirmed'])
  assert.equal(enqueued, 0)

  // … until START (the button this time): opt-in for transactional + assistant, a grant per persona held
  await h.say({ button: 'wa:start' })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[2]!['p_purposes'], ['transactional', 'assistant'])
  assert.equal(calls[2]!['p_source'], 'whatsapp_button')
  assert.equal(calls[2]!['p_keyword'], 'button:wa:start')
  const active = db.tables['agent_grants']!.filter((g) => g['channel'] === 'whatsapp' && !g['revoked_at'])
  assert.deepEqual(active.map((g) => g['persona']).sort(), ['buyer', 'provider'])
  assert.ok(active.every((g) => g['channel_identity'] === `+${PHONE}`))
  assert.equal((active[0]!['consent'] as Row)['keyword'], 'button:wa:start')
  assert.deepEqual(kinds(h.sent), ['wa_opt_out_confirmed', 'wa_opt_in_confirmed'])
  await h.say({ body: 'hi' })
  assert.deepEqual(kinds(h.sent), ['wa_opt_out_confirmed', 'wa_opt_in_confirmed', 'wa_menu'])
})

test('"no" and "cancel" revoke nothing and record nothing', async () => {
  const db = stopWorld()
  const calls = consentRpc(db)
  const h = harness(db)
  await h.say({ body: 'no' })
  await h.say({ body: 'cancel' })
  await h.say({ button: 'nudge:no:7f3a2100-0000-4000-8000-000000000000' })
  assert.equal(calls.length, 0)
  assert.ok(db.tables['agent_grants']!.every((g) => g['revoked_at'] === null))
})

test('START keeps the scopes consented from THIS phone per persona (a first opt-in grants none)', async () => {
  const db = stopWorld()
  consentRpc(db)
  const h = harness(db)
  await h.say({ body: 'START' })
  const active = db.tables['agent_grants']!.filter((g) => g['channel'] === 'whatsapp' && !g['revoked_at'])
  const byPersona = Object.fromEntries(active.map((g) => [g['persona'], g['scopes']]))
  assert.deepEqual(byPersona['buyer'], ['support_lookup'])
  assert.deepEqual(byPersona['provider'], ['submit_quote'])
})

test('an unknown number: STOP is recorded with no user; START records the phone and points to sign-up', async () => {
  const db = world()
  db.tables['wa_conversations']![0]!['user_id'] = null
  db.tables['users'] = []
  const calls = consentRpc(db)
  const h = harness(db)
  await h.say({ body: 'STOP' })
  assert.equal(calls[0]!['p_user_id'], null)
  assert.equal(calls[0]!['p_action'], 'opt_out')
  assert.deepEqual(kinds(h.sent), ['wa_opt_out_confirmed'])
  await h.say({ body: 'START' })
  assert.equal(calls[1]!['p_user_id'], null)
  assert.equal(h.sent[1]!.kind, 'wa_opt_in_confirmed')
  assert.match(h.sent[1]!.text ?? '', /\/signup/)
  assert.equal((db.tables['agent_grants'] ?? []).length, 0)
})

test('0086 not applied: STOP falls back to revoking grants and confirming; the menu still answers afterwards', async () => {
  const db = stopWorld()
  consentRpc(db, { missing: true })
  missingTables(db, ['wa_phone_consents'])
  const h = harness(db)
  await h.say({ body: 'STOP' })
  assert.ok(db.tables['agent_grants']!.filter((g) => g['channel'] === 'whatsapp').every((g) => g['revoked_at']))
  assert.deepEqual(kinds(h.sent), ['wa_opt_out_confirmed'])
  await h.say({ body: 'hi' })
  assert.deepEqual(kinds(h.sent), ['wa_opt_out_confirmed', 'wa_menu'])
})

test('a message older than the window: STOP is still recorded, nothing is answered', async () => {
  const db = stopWorld()
  const calls = consentRpc(db)
  const h = harness(db)
  await h.say({ body: 'STOP', at: new Date(NOW.getTime() - 30 * 3600_000) })
  assert.equal(calls.length, 1)
  assert.deepEqual(h.sent, [])
})

// ── BSUID, recycled numbers, number change ────────────────────────────────────

test('a BSUID-only sender gets "share your phone number" and nothing else (once an hour)', async () => {
  const db = world()
  Object.assign(db.tables['wa_conversations']![0]!, { phone_e164: 'u:IN.13491208655302741918', user_id: null })
  const calls = consentRpc(db)
  const h = harness(db)
  await h.say({ body: 'STOP' })
  await h.say({ body: 'hi' })
  assert.equal(calls.length, 0, 'no phone, nothing to record against')
  assert.deepEqual(kinds(h.sent), ['wa_share_phone'])
})

test('a dormant account: "sign in to confirm it is you" and nothing else for it — STOP still works', async () => {
  const db = stopWorld()
  Object.assign(db.tables['users']![0]!, { last_seen_at: new Date(NOW.getTime() - 120 * 86400_000).toISOString(), created_at: new Date(NOW.getTime() - 400 * 86400_000).toISOString() })
  const calls = consentRpc(db)
  const h = harness(db)
  await h.say({ body: 'START' })
  assert.equal(calls.length, 0, 'no consent for a dormant account')
  assert.deepEqual(kinds(h.sent), ['wa_rebind_confirm'])
  assert.match(h.sent[0]!.text ?? '', /\/login/)
  await h.say({ button: 'wa:menu:track' })
  assert.deepEqual(kinds(h.sent), ['wa_rebind_confirm'], 'no account data, and the prompt is spaced')
  await h.say({ body: 'STOP' })
  assert.equal(calls.length, 1)
  assert.ok(db.tables['agent_grants']!.filter((g) => g['channel'] === 'whatsapp').every((g) => g['revoked_at']))
  // after signing in (last_seen_at refreshes) the account is served again
  db.tables['users']![0]!['last_seen_at'] = NOW.toISOString()
  await h.say({ body: 'START' })
  assert.equal(calls.length, 2)
})

test('Meta "user changed number": the conversation is unbound and nothing is sent; the next message asks to sign in', async () => {
  const db = stopWorld()
  consentRpc(db)
  const h = harness(db)
  await h.say({ kind: 'system', payload: { type: 'system', system: { type: 'user_changed_number', body: 'User changed number', new_wa_id: '919811111111' } } })
  assert.equal(db.tables['wa_conversations']![0]!['user_id'], null)
  assert.ok(db.tables['agent_grants']!.filter((g) => g['channel'] === 'whatsapp').every((g) => g['revoked_at']))
  assert.deepEqual(h.sent, [])
  // the old account still holds the number in users.phone: it is re-bound, but must confirm (changed after last sign-in)
  db.tables['wa_messages']!.find((m) => m['kind'] === 'system')!['created_at'] = new Date(NOW.getTime() + 1000).toISOString()
  await h.say({ body: 'hi' }, {})
  assert.deepEqual(kinds(h.sent), ['wa_rebind_confirm'])
})

// ── language, data requests, a person ────────────────────────────────────────

test('language: a typed name switches (conversation + account), the list on LANGUAGE, a button switches', async () => {
  const db = world()
  consentRpc(db)
  const h = harness(db)
  await h.say({ body: 'Telugu' })
  assert.equal(db.tables['wa_conversations']![0]!['locale'], 'te')
  assert.equal(db.tables['users']![0]!['preferred_locale'], 'te')
  assert.deepEqual([h.sent[0]!.kind, h.sent[0]!.locale], ['wa_language_changed', 'te'])
  assert.match(h.sent[0]!.text ?? '', /తెలుగు/)
  await h.say({ body: 'language' })
  assert.equal(h.sent[1]!.kind, 'wa_language_list')
  assert.deepEqual(h.sent[1]!.buttons, ['wa:lang:en', 'wa:lang:hi', 'wa:lang:te', 'wa:lang:ta'])
  await h.say({ button: 'wa:lang:ta' })
  assert.equal(db.tables['users']![0]!['preferred_locale'], 'ta')
  assert.deepEqual([h.sent[2]!.kind, h.sent[2]!.locale], ['wa_language_changed', 'ta'])
  // the next menu is in Tamil
  await h.say({ body: 'menu' })
  assert.equal(h.sent[3]!.locale, 'ta')
})

test('MY DATA / DELETE MY DATA → a dpdp_requests row due in 30 days, with the reference in the reply', async () => {
  const db = world()
  consentRpc(db)
  const h = harness(db)
  await h.say({ body: 'my data' })
  await h.say({ body: 'DELETE MY DATA' })
  const rows = db.tables['dpdp_requests']!
  assert.deepEqual(rows.map((r) => [r['kind'], r['source'], r['user_id'], r['phone_e164']]), [['access', 'whatsapp', U, PHONE], ['erasure', 'whatsapp', U, PHONE]])
  assert.equal(new Date(rows[0]!['due_at'] as string).getTime() - NOW.getTime(), 30 * 86400_000)
  assert.equal(h.sent[0]!.kind, 'wa_data_request_received')
  assert.match(h.sent[0]!.text ?? '', /D-[0-9A-Z-]+/)
})

test('track my order: the latest 3 of the user\'s own orders with status labels; talk to a person opens one ticket', async () => {
  const db = world({
    msme_profiles: [{ id: 'm1', user_id: U }],
    orders: [
      { order_number: 'AMC-1', status: 'placed', msme_id: 'm1', created_at: '2026-09-20T00:00:00Z', deleted_at: null },
      { order_number: 'AMC-2', status: 'in_progress', msme_id: 'm1', created_at: '2026-09-21T00:00:00Z', deleted_at: null },
      { order_number: 'AMC-3', status: 'delivered', msme_id: 'm1', created_at: '2026-09-22T00:00:00Z', deleted_at: null },
      { order_number: 'AMC-4', status: 'completed', msme_id: 'm1', created_at: '2026-09-23T00:00:00Z', deleted_at: null },
      { order_number: 'OTHER-1', status: 'placed', msme_id: 'm2', created_at: '2026-09-24T00:00:00Z', deleted_at: null },
    ],
  })
  consentRpc(db)
  const h = harness(db)
  await h.say({ button: 'wa:menu:track' })
  const text = h.sent[0]!.text ?? ''
  assert.match(text, /AMC-4: Completed/)
  assert.match(text, /AMC-2: In progress/)
  assert.doesNotMatch(text, /AMC-1|OTHER-1/)
  await h.say({ button: 'wa:menu:human' })
  await h.say({ button: 'wa:menu:human' })
  assert.equal(db.tables['support_tickets']!.length, 1, 'one open ticket per user and channel')
  assert.equal(db.tables['support_tickets']![0]!['reason'], 'human')
  assert.equal(db.tables['wa_conversations']![0]!['support_ticket_id'], db.tables['support_tickets']![0]!['id'])
  assert.match(h.sent[1]!.text ?? '', /T-[0-9A-Z-]+/)
  // with a person on the thread, free text is stored for them — no menu
  const before = h.sent.length
  await h.say({ body: 'hello, is anyone there', at: new Date(NOW.getTime()) }, {})
  assert.equal(h.sent.length, before)
})

test('JOIN before START asks for the Start tap; nothing is granted', async () => {
  const db = world({ agent_grants: [] })
  const calls = consentRpc(db)
  const h = harness(db)
  await h.say({ body: 'JOIN' })
  assert.equal(calls.length, 0)
  assert.equal((db.tables['agent_grants'] ?? []).length, 0)
  assert.deepEqual([h.sent[0]!.kind, h.sent[0]!.buttons], ['wa_join_needs_start', ['wa:start']])
})
