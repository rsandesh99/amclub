import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeDb } from '../testing/fake-db'
import { routeFreeText } from './confirmations'

/**
 * Audit M42 — a typed "yes" is bound to at most ONE open proposal across Munshi,
 * procurement and support before any agent may treat it as an approval.
 */

const U = 'user-1'
const NOW = new Date('2026-09-24T12:00:00Z')
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString()

function world(opts: { munshi?: Array<{ run: string; sentMinAgo: number }>; procurementOpen?: boolean; supportOpen?: boolean; quotedOut?: { vendor: string; run: string | null } } = {}) {
  const outs: Record<string, unknown>[] = []
  const drafts: Record<string, unknown>[] = []
  for (const m of opts.munshi ?? []) {
    drafts.push({ id: `d-${m.run}`, user_id: U, status: 'proposed', run_id: m.run, delivered: { whatsapp: `out-${m.run}` }, created_at: ago(m.sentMinAgo), deleted_at: null })
    outs.push({ id: `out-${m.run}`, conversation_id: 'conv', direction: 'out', vendor_message_id: `wamid.${m.run}`, created_at: ago(m.sentMinAgo), payload: { run_id: m.run } })
  }
  if (opts.procurementOpen) outs.push({ id: 'out-p', conversation_id: 'conv', direction: 'out', vendor_message_id: 'wamid.p1', created_at: ago(1), payload: { run_id: 'p1', procurement: true } })
  if (opts.quotedOut) outs.push({ id: 'out-q', conversation_id: 'conv', direction: 'out', vendor_message_id: opts.quotedOut.vendor, created_at: ago(500), payload: opts.quotedOut.run ? { run_id: opts.quotedOut.run } : { detail: 'sent' } })
  return fakeDb({
    wa_messages: outs,
    munshi_drafts: drafts,
    procurement_sessions: [{ id: 'ps', user_id: U, state: 'quotes_in', open_run_id: opts.procurementOpen ? 'p1' : null, deleted_at: null }],
    agent_runs: [
      ...(opts.procurementOpen ? [{ id: 'p1', user_id: U, status: 'awaiting_confirmation', surface: 'whatsapp', meta: { agent: 'procurement' }, created_at: ago(1) }] : []),
      ...(opts.supportOpen ? [{ id: 's1', user_id: U, status: 'awaiting_confirmation', surface: 'whatsapp', meta: { agent: 'support' }, created_at: ago(2) }] : []),
    ],
    agent_settings: [
      { key: 'agents_enabled', value: { procurement: true, munshi: true } },
      { key: 'cohort_user_ids', value: [U] },
    ],
  })
}

function hooks() {
  const jobs: Array<Record<string, unknown>> = []
  return {
    jobs,
    h: {
      enqueueMunshiDecide: async (j: object) => {
        jobs.push({ q: 'munshi', ...j })
        return 'j'
      },
      enqueueProcurementTurn: async (j: object) => {
        jobs.push({ q: 'procurement', ...j })
        return 'j'
      },
    },
  }
}

const text = (body: string, payload: Record<string, unknown> = {}) => ({ kind: 'text', body, payload: { type: 'text', text: { body }, ...payload } })
const approving = (jobs: Array<Record<string, unknown>>) => jobs.filter((j) => j['textApproval'] === true)

test('a Munshi draft AND a procurement proposal open: a typed yes approves NEITHER; the cards come back', async () => {
  const db = world({ munshi: [{ run: 'm1', sentMinAgo: 3 }], procurementOpen: true })
  const { jobs, h } = hooks()
  const r = await routeFreeText(db.client, { messageId: 'in-1', conversationId: 'conv', userId: U, locale: 'en', row: text('yes'), procurementSessionId: 'ps', now: NOW }, h)
  assert.equal(r.routed, true)
  assert.equal(r.binding?.status, 'ambiguous')
  assert.deepEqual(approving(jobs), [], 'no job may approve on this text')
  assert.ok(jobs.some((j) => j['q'] === 'munshi' && j['action'] === 'reask' && j['runId'] === 'm1'), 'the Munshi card is re-sent')
  assert.ok(jobs.some((j) => j['q'] === 'procurement' && j['textApproval'] === false), 'the session takes the message with text approval off (its yes re-sends its card)')
  assert.ok(!jobs.some((j) => j['action'] === 'utterance'), 'Munshi never reads this yes')
})

test('two Munshi drafts: a typed yes re-sends both cards and approves none', async () => {
  const db = world({ munshi: [{ run: 'm1', sentMinAgo: 5 }, { run: 'm2', sentMinAgo: 2 }] })
  const { jobs, h } = hooks()
  const r = await routeFreeText(db.client, { messageId: 'in-2', conversationId: 'conv', userId: U, locale: 'hi', row: text('haan'), procurementSessionId: null, now: NOW }, h)
  assert.equal(r.routed, true)
  assert.deepEqual(jobs.map((j) => `${j['action']}:${j['runId']}`).sort(), ['reask:m1', 'reask:m2'])
})

test('the only open proposal, delivered minutes ago: bound — Munshi reads the text with approval on', async () => {
  const db = world({ munshi: [{ run: 'm1', sentMinAgo: 4 }] })
  const { jobs, h } = hooks()
  await routeFreeText(db.client, { messageId: 'in-3', conversationId: 'conv', userId: U, locale: 'en', row: text('yes send it'), procurementSessionId: null, now: NOW }, h)
  assert.deepEqual(jobs, [{ q: 'munshi', runId: 'm1', messageId: 'in-3', action: 'utterance', textApproval: true }])
})

test('a quoted reply binds exactly the quoted card, even with another proposal open', async () => {
  const db = world({ munshi: [{ run: 'm1', sentMinAgo: 2 }], procurementOpen: true })
  const { jobs, h } = hooks()
  await routeFreeText(db.client, { messageId: 'in-4', conversationId: 'conv', userId: U, locale: 'en', row: text('yes', { context: { id: 'wamid.p1' } }), procurementSessionId: 'ps', now: NOW }, h)
  assert.deepEqual(approving(jobs).map((j) => j['q']), ['procurement'])
  assert.ok(!jobs.some((j) => j['q'] === 'munshi'))
})

test('a reply quoting a message that is not an open proposal approves nothing', async () => {
  const db = world({ munshi: [{ run: 'm1', sentMinAgo: 2 }], quotedOut: { vendor: 'wamid.old', run: 'closed-run' } })
  const { jobs, h } = hooks()
  const r = await routeFreeText(db.client, { messageId: 'in-5', conversationId: 'conv', userId: U, locale: 'en', row: text('yes', { context: { id: 'wamid.old' } }), procurementSessionId: null, now: NOW }, h)
  assert.equal(r.binding?.status, 'ambiguous')
  assert.deepEqual(approving(jobs), [])
})

test('a Munshi draft outside the text window: a yes re-sends the card; other text goes on to the next routes', async () => {
  const db = world({ munshi: [{ run: 'm1', sentMinAgo: 180 }] })
  const a = hooks()
  await routeFreeText(db.client, { messageId: 'in-6', conversationId: 'conv', userId: U, locale: 'en', row: text('yes'), procurementSessionId: null, now: NOW }, a.h)
  assert.deepEqual(a.jobs.map((j) => j['action']), ['reask'])
  const b = hooks()
  const r = await routeFreeText(db.client, { messageId: 'in-7', conversationId: 'conv', userId: U, locale: 'en', row: text('where is my payout'), procurementSessionId: null, now: NOW }, b.h)
  assert.equal(r.routed, false)
  assert.deepEqual(b.jobs, [])
})

test('a support nudge offer counts as an open proposal: with a Munshi draft, nothing is approved on text', async () => {
  const db = world({ munshi: [{ run: 'm1', sentMinAgo: 3 }], supportOpen: true })
  const { jobs, h } = hooks()
  await routeFreeText(db.client, { messageId: 'in-8', conversationId: 'conv', userId: U, locale: 'en', row: text('yes send it'), procurementSessionId: null, now: NOW }, h)
  assert.deepEqual(approving(jobs), [])
  assert.deepEqual(jobs.map((j) => j['action']), ['reask'])
})

test('an active procurement session with nothing open still takes the buyer\'s messages (approval off)', async () => {
  const db = world()
  const { jobs, h } = hooks()
  const r = await routeFreeText(db.client, { messageId: 'in-9', conversationId: 'conv', userId: U, locale: 'en', row: { kind: 'image', body: null, payload: {} }, procurementSessionId: 'ps', now: NOW }, h)
  assert.equal(r.routed, true)
  assert.deepEqual(jobs, [{ q: 'procurement', userId: U, surface: 'whatsapp', sessionId: 'ps', conversationId: 'conv', messageId: 'in-9', textApproval: false }])
})
