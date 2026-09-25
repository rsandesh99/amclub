import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MediaRefusedError, type WhatsAppProvider } from '@amclub/agent-core'
import { fakeDb } from '../testing/fake-db'
import { SWEEP_MAX_AGE_MS, resolveInboundMedia, sweepUnprocessedInbound } from './inbound'

/**
 * Audit M33 (stored-but-unprocessed messages are re-driven and reported) and
 * M34 (media is fetched by the job, capped, only for an opted-in number).
 */

const NOW = new Date('2026-09-24T12:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

test('the sweep re-enqueues unprocessed inbound rows older than a minute, and only those without a job', async () => {
  const db = fakeDb({
    wa_messages: [
      { id: 'fresh', direction: 'in', processed_at: null, created_at: ago(10_000) }, // < 1 min: the original job may still be queued
      { id: 'stuck', direction: 'in', processed_at: null, created_at: ago(5 * 60_000) }, // its first enqueue failed
      { id: 'queued', direction: 'in', processed_at: null, created_at: ago(3 * 60_000) }, // a job exists (the id collides)
      { id: 'done', direction: 'in', processed_at: ago(60_000), created_at: ago(10 * 60_000) },
      { id: 'out', direction: 'out', processed_at: null, created_at: ago(10 * 60_000) },
      { id: 'ancient', direction: 'in', processed_at: null, created_at: ago(SWEEP_MAX_AGE_MS + 60_000) },
    ],
  })
  const sent: string[] = []
  const r = await sweepUnprocessedInbound(db.client, async (id) => {
    sent.push(id)
    return id === 'queued' ? null : `job-${id}`
  }, NOW)
  assert.deepEqual(sent.sort(), ['queued', 'stuck'])
  assert.deepEqual(r, { pending: 2, requeued: 1, stale: 1, error: null })
})

function provider(result: { bytes: Uint8Array; mime: string } | Error, calls: string[]): WhatsAppProvider {
  return {
    name: 'meta_cloud',
    async downloadMedia(ref: string) {
      calls.push(ref)
      if (result instanceof Error) throw result
      return result
    },
  } as unknown as WhatsAppProvider
}

test('media from a number with no WhatsApp grant is never downloaded', async () => {
  const db = fakeDb({ wa_messages: [{ id: 'm1', payload: { amc_media_ref: 'MEDIA1' } }] })
  const calls: string[] = []
  const r = await resolveInboundMedia(db.client, { id: 'm1', conversation_id: 'c1', media_ref: null, mime: 'image/jpeg', payload: { amc_media_ref: 'MEDIA1' } }, [], { provider: provider({ bytes: new Uint8Array(3), mime: 'image/jpeg' }, calls), bucket: 'wa-media' })
  assert.equal(r, 'skipped_not_opted_in')
  assert.deepEqual(calls, [])
  assert.equal((db.tables['wa_messages']![0]!['payload'] as Record<string, unknown>)['amc_media_status'], 'skipped_not_opted_in')
})

test('an opted-in number: downloaded (through the capped driver) and stored under the conversation', async () => {
  const db = fakeDb({ wa_messages: [{ id: 'm2', payload: { id: 'wamid.X', amc_media_ref: 'MEDIA2' }, media_ref: null }] })
  const calls: string[] = []
  const r = await resolveInboundMedia(db.client, { id: 'm2', conversation_id: 'c1', media_ref: null, mime: null, payload: { id: 'wamid.X', amc_media_ref: 'MEDIA2' } }, [{ id: 'g' }], { provider: provider({ bytes: new Uint8Array(10), mime: 'audio/ogg' }, calls), bucket: 'wa-media' })
  assert.equal(r, 'stored')
  assert.deepEqual(calls, ['MEDIA2'])
  assert.deepEqual(db.uploads, [{ bucket: 'wa-media', path: 'c1/wamid.X.ogg', bytes: 10 }])
  assert.equal(db.tables['wa_messages']![0]!['media_ref'], 'c1/wamid.X.ogg')
})

test('a refused download (too large / wrong type / timeout) is recorded and the message is still handled', async () => {
  const db = fakeDb({ wa_messages: [{ id: 'm3', payload: { amc_media_ref: 'MEDIA3' } }] })
  const r = await resolveInboundMedia(db.client, { id: 'm3', conversation_id: 'c1', media_ref: null, mime: null, payload: { amc_media_ref: 'MEDIA3' } }, [{ id: 'g' }], { provider: provider(new MediaRefusedError('too_large', 'declared 99999999'), []), bucket: 'wa-media' })
  assert.equal(r, 'refused')
  assert.equal((db.tables['wa_messages']![0]!['payload'] as Record<string, unknown>)['amc_media_status'], 'refused:too_large')
  assert.deepEqual(db.uploads, [])
})
