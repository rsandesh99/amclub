import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Ledger } from '@amclub/agent-core'
import { fakeDb } from '../testing/fake-db'
import { boundConversationFor, conversationServesUser, reconcileConversationOwner, whatsappGrantsFor } from './binding'

/**
 * Audit M41 — a WhatsApp conversation acts for a user only while that user's
 * CURRENT phone is its phone; grants count only for the phone they came from.
 */

const A = 'user-a'
const B = 'user-b'
const PHONE = '919800000001'

function world() {
  return fakeDb({
    users: [
      { id: A, phone: '+919811111111', preferred_locale: 'en', roles: ['provider', 'msme'] }, // A moved to a new number
      { id: B, phone: `+${PHONE}`, preferred_locale: 'hi', roles: ['msme'] }, // B holds the old number now
    ],
    wa_conversations: [{ id: 'conv-1', phone_e164: PHONE, user_id: A, active_session_id: 'onb-1', support_ticket_id: 'tick-1', procurement_session_id: 'ps-1', locale: 'en' }],
    agent_grants: [
      { id: 'g-old', user_id: A, persona: 'provider', channel: 'whatsapp', channel_identity: `+${PHONE}`, scopes: ['submit_quote'], revoked_at: null },
      { id: 'g-new', user_id: A, persona: 'provider', channel: 'whatsapp', channel_identity: '+919811111111', scopes: ['submit_quote'], revoked_at: null },
      { id: 'g-web', user_id: A, persona: 'provider', channel: 'web', channel_identity: null, scopes: ['submit_quote'], revoked_at: null },
    ],
    munshi_drafts: [
      { id: 'd-wa', user_id: A, status: 'proposed', run_id: 'run-d1', delivered: { whatsapp: 'wam-1' }, deleted_at: null },
      { id: 'd-web', user_id: A, status: 'proposed', run_id: 'run-d2', delivered: { notification: true }, deleted_at: null },
    ],
    procurement_sessions: [{ id: 'ps-1', user_id: A, conversation_id: 'conv-1', state: 'quotes_in', open_run_id: 'run-p1', deleted_at: null }],
  })
}

function fakeLedger() {
  const runs = new Map<string, string>([['run-d1', 'awaiting_confirmation'], ['run-p1', 'awaiting_confirmation']])
  const events: string[] = []
  const ledger = {
    async getRun(id: string) {
      return runs.has(id) ? ({ id, status: runs.get(id) } as unknown) : null
    },
    async appendEvent(e: { runId: string; kind: string }) {
      events.push(`${e.runId}:${e.kind}`)
    },
    async transitionRun(id: string, _from: string, to: string) {
      runs.set(id, to)
    },
  } as unknown as Ledger
  return { ledger, runs, events }
}

test('a phone that changed hands: unbind, revoke that phone\'s grants, cancel what was delivered there, bind the new holder', async () => {
  const db = world()
  const l = fakeLedger()
  const r = await reconcileConversationOwner(db.client, { id: 'conv-1', phone_e164: PHONE, user_id: A }, { ledger: l.ledger })
  assert.equal(r.unboundFrom, A)
  assert.equal(r.userId, B, 'the phone\'s current holder is bound')
  const conv = db.tables['wa_conversations']![0]!
  assert.equal(conv['user_id'], B)
  assert.equal(conv['active_session_id'], null)
  assert.equal(conv['support_ticket_id'], null)
  assert.equal(conv['procurement_session_id'], null)
  const grants = Object.fromEntries(db.tables['agent_grants']!.map((g) => [g['id'], g['revoked_at']]))
  assert.ok(grants['g-old'], 'the grant given from the old phone is revoked')
  assert.equal(grants['g-new'], null, 'the grant from the user\'s new phone stays')
  assert.equal(grants['g-web'], null, 'the web grant stays')
  const drafts = Object.fromEntries(db.tables['munshi_drafts']!.map((d) => [d['id'], d['status']]))
  assert.equal(drafts['d-wa'], 'expired', 'a draft whose buttons went to the old phone is cancelled')
  assert.equal(drafts['d-web'], 'proposed', 'a web-only draft stays')
  assert.equal(db.tables['procurement_sessions']![0]!['state'], 'failed')
  assert.equal(l.runs.get('run-d1'), 'cancelled')
  assert.equal(l.runs.get('run-p1'), 'cancelled')
})

test('an owner who still holds the phone is left alone', async () => {
  const db = fakeDb({ users: [{ id: A, phone: `+${PHONE}` }], wa_conversations: [{ id: 'conv-1', phone_e164: PHONE, user_id: A }], agent_grants: [{ id: 'g', user_id: A, channel: 'whatsapp', channel_identity: `+${PHONE}`, revoked_at: null }] })
  const r = await reconcileConversationOwner(db.client, { id: 'conv-1', phone_e164: PHONE, user_id: A })
  assert.equal(r.unboundFrom, null)
  assert.equal(r.userId, A)
  assert.equal(db.tables['agent_grants']![0]!['revoked_at'], null)
})

test('nobody holds the phone any more: unbound, and stays unbound', async () => {
  const db = fakeDb({ users: [{ id: A, phone: '+919811111111' }], wa_conversations: [{ id: 'conv-1', phone_e164: PHONE, user_id: A }] })
  const r = await reconcileConversationOwner(db.client, { id: 'conv-1', phone_e164: PHONE, user_id: A })
  assert.equal(r.userId, null)
  assert.equal(db.tables['wa_conversations']![0]!['user_id'], null)
})

test('grants and delivery follow the CURRENT phone, never the most recent conversation', async () => {
  const db = world()
  // A's old conversation (still bound in the DB until the next inbound) is never a delivery target for A
  assert.equal(await boundConversationFor(db.client, A), null)
  assert.equal(await conversationServesUser(db.client, { user_id: A, phone_e164: PHONE }, A), false)
  assert.deepEqual((await whatsappGrantsFor(db.client, A, PHONE)).map((g) => g.id), ['g-old'])
  assert.deepEqual((await whatsappGrantsFor(db.client, A, '919811111111')).map((g) => g.id), ['g-new'])
  db.tables['wa_conversations']!.push({ id: 'conv-2', phone_e164: '919811111111', user_id: A })
  assert.equal((await boundConversationFor(db.client, A))?.id, 'conv-2')
})
