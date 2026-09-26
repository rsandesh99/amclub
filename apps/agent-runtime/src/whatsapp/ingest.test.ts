import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeStubDriver, type InboundMessage } from '@amclub/agent-core'
import { fakeDb } from '../testing/fake-db'
import {
  applyStatus,
  ingestWaWebhook,
  isStaleInbound,
  markInboundStaleIfOld,
  recordAccountChange,
  redactInbound,
  storeInbound,
  templateMirrorPatch,
  upsertInboundConversation,
} from './ingest'

/**
 * ADR-030 — the webhook ingest: the window never moves backwards, a BSUID never becomes a phone, secrets typed into
 * chat are stored redacted, statuses carry cost and suppression, account changes feed the template mirror, and a
 * stale inbound message is never answered.
 */

const NOW = new Date('2026-10-02T10:00:00Z')
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()
const H = 3600 * 1000
function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    vendorMessageId: 'wamid.IN1', fromE164: '919876543210', bsuid: null, kind: 'text', body: 'hello', mediaRef: null, mime: null, buttonPayload: null,
    timestamp: NOW.toISOString(), referral: null, contextId: null, newWaId: null, flowResponse: null,
    raw: { from: '919876543210', id: 'wamid.IN1', timestamp: String(NOW.getTime() / 1000), type: 'text', text: { body: 'hello' } },
    ...over,
  }
}

test('the 24-hour window only ever moves forward', async () => {
  const future = new Date(NOW.getTime() + 20 * H).toISOString()
  const db = fakeDb({ wa_conversations: [{ id: 'c1', phone_e164: '919876543210', user_id: 'u1', locale: 'hi', window_open_until: future, last_inbound_at: iso(0) }] })
  // a late-delivered message from 6 h ago: its own window would end in 18 h, before the stored 20 h — nothing moves back
  await upsertInboundConversation(db.client, msg({ timestamp: iso(6 * H) }), NOW)
  assert.equal(db.tables['wa_conversations']![0]!['window_open_until'], future)
  assert.equal(db.tables['wa_conversations']![0]!['last_inbound_at'], iso(0))
  // a new message now → the window moves to now + 24 h
  await upsertInboundConversation(db.client, msg({ timestamp: NOW.toISOString() }), NOW)
  assert.equal(db.tables['wa_conversations']![0]!['window_open_until'], new Date(NOW.getTime() + 24 * H).toISOString())
})

test('a BSUID-only sender is keyed u:<bsuid>, never bound, never reduced to digits', async () => {
  const db = fakeDb({ wa_conversations: [], users: [{ id: 'u9', phone: '+919187000000', preferred_locale: 'en', roles: ['msme'] }] })
  const c = await upsertInboundConversation(db.client, msg({ fromE164: null, bsuid: 'IN.9187000000' }), NOW)
  const row = db.tables['wa_conversations']![0]!
  assert.equal(row['phone_e164'], 'u:IN.9187000000')
  assert.equal(row['bsuid'], 'IN.9187000000')
  assert.equal(row['user_id'], null)
  assert.equal(c.user_id, null)
})

test('a phone message carrying a BSUID records it; a later BSUID-only message lands in that phone conversation', async () => {
  const db = fakeDb({ wa_conversations: [{ id: 'c1', phone_e164: '919876543210', user_id: 'u1', locale: 'en', window_open_until: null, bsuid: null }] })
  await upsertInboundConversation(db.client, msg({ bsuid: 'IN.abc' }), NOW)
  assert.equal(db.tables['wa_conversations']![0]!['bsuid'], 'IN.abc')
  const c = await upsertInboundConversation(db.client, msg({ fromE164: null, bsuid: 'IN.abc' }), NOW)
  assert.equal(c.id, 'c1')
  assert.equal(db.tables['wa_conversations']!.length, 1)
})

test('a new phone conversation is bound to the phone holder, in their language (ta included)', async () => {
  const db = fakeDb({ wa_conversations: [], users: [{ id: 'u5', phone: '+919876543210', preferred_locale: 'ta', roles: ['msme'] }] })
  const c = await upsertInboundConversation(db.client, msg(), NOW)
  assert.deepEqual({ user_id: c.user_id, locale: c.locale }, { user_id: 'u5', locale: 'ta' })
})

test('an ad referral opens the 72-hour entry window and is kept as the first referral', async () => {
  const db = fakeDb({ wa_conversations: [{ id: 'c1', phone_e164: '919876543210', user_id: null, locale: 'en', window_open_until: null }] })
  const referral = { sourceUrl: 'https://fb.me/x', sourceId: 'AD1', sourceType: 'ad', headline: 'GST', body: null, mediaType: null, ctwaClid: 'C1' }
  await upsertInboundConversation(db.client, msg({ referral }), NOW)
  const row = db.tables['wa_conversations']![0]!
  assert.equal(row['entry_window_until'], new Date(NOW.getTime() + 72 * H).toISOString())
  assert.equal((row['first_referral'] as { sourceId: string }).sourceId, 'AD1')
  await upsertInboundConversation(db.client, msg({ referral: { ...referral, sourceId: 'AD2' } }), NOW)
  assert.equal((db.tables['wa_conversations']![0]!['first_referral'] as { sourceId: string }).sourceId, 'AD1')
})

test('secrets typed into chat are stored redacted, in the body and the payload', () => {
  const r = redactInbound({ body: 'my card 4111 1111 1111 1111 and OTP 482913', raw: { type: 'text', text: { body: 'my card 4111 1111 1111 1111 and OTP 482913' } } })
  assert.equal(r.body, 'my card [removed] and OTP [removed]')
  assert.equal((r.payload['text'] as { body: string }).body, 'my card [removed] and OTP [removed]')
  assert.deepEqual((r.payload['amc_redacted'] as string[]).sort(), ['card', 'secret_code'])
  const clean = redactInbound({ body: 'GST filing for 3 shops', raw: { text: { body: 'GST filing for 3 shops' } } })
  assert.equal(clean.payload['amc_redacted'], undefined)
})

test('storeInbound: the redacted row, the media ref for the job, one job enqueued, and a delivery suppression lifted', async () => {
  const db = fakeDb({
    wa_conversations: [{ id: 'c1', phone_e164: '919876543210', user_id: 'u1', locale: 'en', window_open_until: null }],
    wa_messages: [],
    wa_suppressions: [{ phone_e164: '919876543210', reason: 'not_on_whatsapp', until: new Date(NOW.getTime() + 10 * 24 * H).toISOString() }],
  })
  const jobs: string[] = []
  const stored = await storeInbound(db.client, msg({ kind: 'image', body: 'cvv 123', mediaRef: 'MEDIA1', mime: 'image/jpeg', raw: { type: 'image', image: { id: 'MEDIA1', caption: 'cvv 123' } } }), async (id) => { jobs.push(id); return id }, NOW)
  assert.equal(stored, true)
  const row = db.tables['wa_messages']![0]!
  assert.equal(row['body'], 'cvv [removed]')
  assert.equal(((row['payload'] as Record<string, unknown>)['image'] as { caption: string }).caption, 'cvv [removed]')
  assert.equal((row['payload'] as Record<string, unknown>)['amc_media_ref'], 'MEDIA1')
  assert.equal(row['processed_at'], null)
  assert.deepEqual(jobs, [row['id']])
  assert.equal(db.tables['wa_suppressions']![0]!['until'], NOW.toISOString())
})

test('stale inbound: older than 24 h when the job runs → marked processed with amc_stale, never answered', async () => {
  assert.equal(isStaleInbound(iso(25 * H), NOW), true)
  assert.equal(isStaleInbound(iso(23 * H), NOW), false)
  assert.equal(isStaleInbound(null, NOW), false)
  const old = { id: 'm1', payload: { timestamp: String(Math.floor((NOW.getTime() - 30 * H) / 1000)), type: 'text' } }
  const fresh = { id: 'm2', payload: { timestamp: String(Math.floor(NOW.getTime() / 1000)), type: 'text' } }
  const db = fakeDb({ wa_messages: [{ ...old, processed_at: null }, { ...fresh, processed_at: null }] })
  assert.equal(await markInboundStaleIfOld(db.client, old, NOW), true)
  assert.equal(await markInboundStaleIfOld(db.client, fresh, NOW), false)
  assert.equal(db.tables['wa_messages']![0]!['processed_at'], NOW.toISOString())
  assert.equal((db.tables['wa_messages']![0]!['payload'] as Record<string, unknown>)['amc_stale'], true)
  assert.equal(db.tables['wa_messages']![1]!['processed_at'], null)
})

test('a status carries its pricing as integer millipaise; a failed 131026 records the suppression', async () => {
  const db = fakeDb({ wa_messages: [{ id: 'o1', vendor_message_id: 'wamid.O1', status: 'sent' }, { id: 'o2', vendor_message_id: 'wamid.O2', status: 'sent' }], wa_suppressions: [] })
  const rates = { utility: 11_500, marketing: 86_310 }
  await applyStatus(db.client, { vendorMessageId: 'wamid.O1', status: 'delivered', timestamp: iso(0), errorCode: null, errorTitle: null, pricing: { billable: true, category: 'utility', pricingModel: 'PMP', type: 'regular' }, recipientId: '919876543210', raw: {} }, rates, NOW)
  assert.deepEqual(
    { s: db.tables['wa_messages']![0]!['status'], c: db.tables['wa_messages']![0]!['cost_millipaise'], b: db.tables['wa_messages']![0]!['billable'], p: db.tables['wa_messages']![0]!['pricing_category'] },
    { s: 'delivered', c: 11_500, b: true, p: 'utility' },
  )
  await applyStatus(db.client, { vendorMessageId: 'wamid.O2', status: 'failed', timestamp: iso(0), errorCode: 131026, errorTitle: 'Message undeliverable', pricing: null, recipientId: '919876543210', raw: {} }, rates, NOW)
  assert.equal(db.tables['wa_messages']![1]!['error_code'], 131026)
  assert.equal(db.tables['wa_suppressions']![0]!['reason'], 'not_on_whatsapp')
})

test('account changes are stored and template status / category feed the mirror', async () => {
  const db = fakeDb({ wa_account_events: [], wa_templates: [] })
  await recordAccountChange(db.client, { field: 'message_template_status_update', entryId: 'WABA1', value: { event: 'APPROVED', message_template_id: 77, message_template_name: 'amc_order_placed_te', message_template_language: 'te', reason: 'NONE' } }, NOW)
  await recordAccountChange(db.client, { field: 'template_category_update', entryId: 'WABA1', value: { message_template_name: 'amc_order_placed_te', message_template_language: 'te', previous_category: 'UTILITY', new_category: 'MARKETING' } }, NOW)
  await recordAccountChange(db.client, { field: 'phone_number_quality_update', entryId: 'WABA1', value: { event: 'FLAGGED' } }, NOW)
  assert.equal(db.tables['wa_account_events']!.length, 3)
  assert.equal(db.tables['wa_templates']!.length, 1)
  assert.deepEqual({ status: db.tables['wa_templates']![0]!['status'], category: db.tables['wa_templates']![0]!['category'], id: db.tables['wa_templates']![0]!['meta_template_id'] }, { status: 'approved', category: 'marketing', id: '77' })
  assert.deepEqual(templateMirrorPatch({ field: 'message_template_status_update', entryId: null, value: { event: 'REJECTED', message_template_name: 'x', message_template_language: 'en', reason: 'INVALID_FORMAT' } }, NOW), { name: 'x', language: 'en', synced_at: NOW.toISOString(), status: 'rejected', rejection_reason: 'INVALID_FORMAT' })
  assert.equal(templateMirrorPatch({ field: 'message_template_status_update', entryId: null, value: { event: 'FLAGGED', message_template_name: 'x', message_template_language: 'en' } }, NOW), null)
})

test('ingestWaWebhook: stores messages + statuses + account events; a named driver without credentials refuses (503)', async () => {
  const db = fakeDb({ wa_conversations: [], wa_messages: [{ id: 'o1', vendor_message_id: 'wamid.OUT1', status: 'sent' }], wa_account_events: [], wa_templates: [], users: [] })
  const body = JSON.stringify({
    entry: [
      { id: 'WABA1', changes: [{ field: 'messages', value: { messages: [{ from: '919876543210', id: 'wamid.IN9', timestamp: String(Math.floor(NOW.getTime() / 1000)), type: 'text', text: { body: 'hi' } }], statuses: [{ id: 'wamid.OUT1', status: 'read', timestamp: String(Math.floor(NOW.getTime() / 1000)) }] } }] },
      { id: 'WABA1', changes: [{ field: 'account_alerts', value: { entity_type: 'WABA', alert_severity: 'WARNING' } }] },
    ],
  })
  const jobs: string[] = []
  const env = { NODE_ENV: 'test', WHATSAPP_WEBHOOK_ALLOW_UNSIGNED: 'true' }
  const r = await ingestWaWebhook(body, {}, async (id) => { jobs.push(id); return id }, { db: db.client, provider: makeStubDriver(() => undefined), env, now: () => NOW, rates: async () => ({}) })
  assert.deepEqual({ ok: r.ok, status: r.status, stored: r.stored, statuses: r.statuses, account: r.account }, { ok: true, status: 200, stored: 1, statuses: 1, account: 1 })
  assert.equal(jobs.length, 1)
  assert.equal(db.tables['wa_messages']![0]!['status'], 'read')
  const refused = await ingestWaWebhook(body, {}, async () => null, { db: db.client, env: { WHATSAPP_DRIVER: 'meta_cloud', WHATSAPP_ACCESS_TOKEN: 't' } })
  assert.deepEqual({ status: refused.status, error: refused.error }, { status: 503, error: 'whatsapp_not_configured' })
  const unsigned = await ingestWaWebhook(body, {}, async () => null, { db: db.client, env: { NODE_ENV: 'production' } })
  assert.equal(unsigned.status, 401)
})
