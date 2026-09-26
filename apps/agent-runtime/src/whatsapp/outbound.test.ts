import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resetWaSendStateForTests, type SendResult, type WhatsAppProvider } from '@amclub/agent-core'
import { fakeDb } from '../testing/fake-db'
import { runtimeSend, sentMessageId, wasDelivered } from './outbound'

/**
 * ADR-030 §3 — every runtime send goes through the one send path. The M42 binding still works: a card's run id rides
 * on its outbound row (so a quoted "yes" binds to exactly that card), and a template fallback without a card can be
 * sent without it.
 */

const NOW = new Date('2026-10-02T10:00:00Z')
function provider(calls: string[]): WhatsAppProvider {
  const ok = async (m: string): Promise<SendResult> => {
    calls.push(m)
    return { ok: true, vendorMessageId: `wamid.${calls.length}`, detail: 'sent' }
  }
  return {
    name: 'meta_cloud',
    sendTemplate: () => ok('template'),
    sendText: () => ok('text'),
    sendButtons: () => ok('buttons'),
    sendCtaUrl: () => ok('cta_url'),
    sendMedia: () => ok('media'),
  } as unknown as WhatsAppProvider
}
function db(window: string | null, consents: Array<[string, string]> = []) {
  return fakeDb({
    wa_conversations: [{ id: 'c1', phone_e164: '919876543210', user_id: 'u1', locale: 'en', window_open_until: window }],
    wa_messages: [],
    wa_phone_consents: consents.map(([purpose, status]) => ({ phone_e164: '919876543210', purpose, status })),
    wa_suppressions: [],
    wa_templates: [],
    agent_settings: [],
  })
}

test('a card inside the window: buttons, the run id and the button ids on the row, keyed and ledgered', async () => {
  resetWaSendStateForTests()
  const d = db(new Date(NOW.getTime() + 3600_000).toISOString())
  const calls: string[] = []
  const r = await runtimeSend(
    { admin: d.client, whatsapp: provider(calls), now: () => NOW },
    { conv: { id: 'c1', phone_e164: '919876543210', user_id: 'u1' }, kind: 'support_reply', purpose: 'assistant', initiation: 'reply', idempotencyKey: 'in1:support:nudge_offer', text: 'Shall I remind them?', buttons: [{ id: 'nudge:yes:run-1', title: 'Yes' }, { id: 'nudge:no:run-1', title: 'No' }], template: { kind: 'support_reply', locale: 'en', values: { title: 'x', body: 'y' } }, runId: '00000000-0000-0000-0000-000000000001', meta: { support: true, run_id: 'run-1' }, fallbackMeta: { support: true, nudge_offer: true } },
  )
  assert.equal(wasDelivered(r), true)
  assert.deepEqual(calls, ['buttons'])
  const row = d.tables['wa_messages']![0]!
  assert.equal(sentMessageId(r), row['id'])
  assert.equal(row['kind'], 'button')
  assert.equal(row['idempotency_key'], 'in1:support:nudge_offer')
  assert.equal((row['payload'] as Record<string, unknown>)['run_id'], 'run-1')
  assert.deepEqual((row['payload'] as Record<string, unknown>)['buttons'], ['nudge:yes:run-1', 'nudge:no:run-1'])
})

test('the same card outside the window: the template goes with fallbackMeta (no run id) — only with the opt-in', async () => {
  resetWaSendStateForTests()
  const closed = new Date(NOW.getTime() - 3600_000).toISOString()
  const req = { conv: { id: 'c1', phone_e164: '919876543210', user_id: 'u1' }, kind: 'support_reply', purpose: 'assistant' as const, initiation: 'reply' as const, idempotencyKey: 'in2:x', text: 'Shall I remind them?', buttons: [{ id: 'nudge:yes:run-2', title: 'Yes' }], template: { kind: 'support_reply', locale: 'en' as const, values: { title: 'x', body: 'y' } }, meta: { run_id: 'run-2' }, fallbackMeta: { nudge_offer: true } }
  const noOptIn = db(closed)
  const skipped = await runtimeSend({ admin: noOptIn.client, whatsapp: provider([]), now: () => NOW }, req)
  assert.deepEqual({ outcome: skipped.outcome, reason: skipped.reason }, { outcome: 'skipped', reason: 'no_consent' })
  assert.equal(sentMessageId(skipped), null)
  const optedIn = db(closed, [['assistant', 'opted_in']])
  const calls: string[] = []
  const r = await runtimeSend({ admin: optedIn.client, whatsapp: provider(calls), now: () => NOW }, req)
  assert.equal(r.usedTemplate, true)
  assert.deepEqual(calls, ['template'])
  const payload = optedIn.tables['wa_messages']![0]!['payload'] as Record<string, unknown>
  assert.equal(payload['run_id'], undefined)
  assert.equal(payload['nudge_offer'], true)
})
