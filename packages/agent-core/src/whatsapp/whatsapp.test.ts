import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  WA_ALWAYS_ALLOWED_KINDS,
  WA_TEMPLATES,
  allTemplateNames,
  classifyKeyword,
  createWhatsAppProvider,
  makeInteraktDriver,
  makeMetaCloudDriver,
  makeStubDriver,
  metaVerifyChallenge,
  templateFor,
  whatsappConfigFromEnv,
} from './index'

// ── recorded fixtures (shapes as the vendors send them) ─────────────────────
const META_TEXT = {
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001111', phone_number_id: 'PNID' },
    contacts: [{ profile: { name: 'Ravi' }, wa_id: '919876543210' }],
    messages: [{ from: '919876543210', id: 'wamid.HBgLOTE5ODc2NTQzMjEwFQIAEhggQUJD', timestamp: '1726800000', type: 'text', text: { body: 'START' } }],
  } }] }],
}
const META_IMAGE_AND_STATUS = {
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: {
    messages: [{ from: '919876543210', id: 'wamid.IMG1', timestamp: '1726800100', type: 'image', image: { id: 'MEDIA123', mime_type: 'image/jpeg', caption: 'site photo' } }],
    statuses: [{ id: 'wamid.OUT1', status: 'delivered', timestamp: '1726800101', recipient_id: '919876543210' }],
  } }] }],
}
const INTERAKT_TEXT = {
  version: '1.0', timestamp: '2026-09-20T10:00:00Z', type: 'message_received',
  data: { customer: { id: 'c1', phone_number: '9876543210', country_code: '+91', traits: {} },
    message: { id: 'int-msg-1', message: 'STOP', chat_message_type: 'Text', media_url: null, received_at_utc: '2026-09-20T10:00:00Z' } },
}
const INTERAKT_DELIVERED = { type: 'message_api_delivered', data: { customer: { phone_number: '9876543210', country_code: '+91' }, message: { id: 'int-out-1', received_at_utc: '2026-09-20T10:01:00Z' } } }

const noNetwork: typeof fetch = (async () => { throw new Error('network call attempted') }) as unknown as typeof fetch

describe('template registry', () => {
  it('covers every transactional kind and never an unknown one', () => {
    for (const k of ['order_placed', 'order_delivered', 'payout_paid', 'rfq_new_quote', 'milestone_added']) expect(templateFor(k, 'hi')?.name).toMatch(/_hi$/)
    expect(templateFor('marketing_blast', 'en')).toBeNull()
    expect(allTemplateNames().length).toBe(new Set(allTemplateNames()).size)
  })
  it('always-allowed kinds are order/payment events only', () => {
    for (const k of WA_ALWAYS_ALLOWED_KINDS) expect(WA_TEMPLATES[k]).toBeDefined()
    expect(WA_ALWAYS_ALLOWED_KINDS.has('rfq_matched')).toBe(false)
    expect(WA_ALWAYS_ALLOWED_KINDS.has('review_prompt')).toBe(false)
  })
  it('classifies opt-in / opt-out keywords, incl. vernacular, case-insensitively', () => {
    expect(classifyKeyword(' Start ')).toBe('opt_in')
    expect(classifyKeyword('JOIN')).toBe('opt_in')
    expect(classifyKeyword('नमस्ते')).toBe('opt_in')
    expect(classifyKeyword('STOP')).toBe('opt_out')
    expect(classifyKeyword('बंद')).toBe('opt_out')
    expect(classifyKeyword('how much for gst filing?')).toBeNull()
  })
})

describe('meta_cloud driver', () => {
  const cfg = { driver: 'meta_cloud' as const, phoneNumberId: 'PNID', accessToken: 'tok', appSecret: 'app-secret', verifyToken: 'vt' }
  it('parses inbound text, media (with caption) and statuses', () => {
    const d = makeMetaCloudDriver(cfg, noNetwork)
    const a = d.parseInbound(META_TEXT)
    expect(a.messages).toHaveLength(1)
    expect(a.messages[0]).toMatchObject({ vendorMessageId: 'wamid.HBgLOTE5ODc2NTQzMjEwFQIAEhggQUJD', fromE164: '919876543210', kind: 'text', body: 'START' })
    const b = d.parseInbound(META_IMAGE_AND_STATUS)
    expect(b.messages[0]).toMatchObject({ kind: 'image', mediaRef: 'MEDIA123', mime: 'image/jpeg', body: 'site photo' })
    expect(b.statuses[0]).toMatchObject({ vendorMessageId: 'wamid.OUT1', status: 'delivered' })
  })
  it('verifies X-Hub-Signature-256 and rejects a tampered body', () => {
    const d = makeMetaCloudDriver(cfg, noNetwork)
    const raw = JSON.stringify(META_TEXT)
    const sig = 'sha256=' + createHmac('sha256', 'app-secret').update(raw).digest('hex')
    expect(d.verifySignature(raw, { 'x-hub-signature-256': sig })).toBe(true)
    expect(d.verifySignature(raw + ' ', { 'x-hub-signature-256': sig })).toBe(false)
    expect(d.verifySignature(raw, { 'x-hub-signature-256': 'sha256=' + 'ab'.repeat(32) })).toBe(false)
    expect(d.verifySignature(raw, {})).toBe(false)
  })
  it('answers the GET verify challenge only with the right token', () => {
    expect(metaVerifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': '12345' }, 'vt')).toBe('12345')
    expect(metaVerifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '12345' }, 'vt')).toBeNull()
  })
  it('sends a template with ordered body params', async () => {
    const calls: { url: string; body: unknown }[] = []
    const f: typeof fetch = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT9' }] }), { status: 200 }) }) as unknown as typeof fetch
    const d = makeMetaCloudDriver(cfg, f)
    const r = await d.sendTemplate('919876543210', 'amc_order_placed_hi', 'hi', ['Order placed', 'AMC-1'])
    expect(r).toEqual({ ok: true, vendorMessageId: 'wamid.OUT9', detail: 'sent' })
    expect(calls[0]?.url).toContain('/PNID/messages')
    expect(calls[0]?.body).toMatchObject({ type: 'template', template: { name: 'amc_order_placed_hi', language: { code: 'hi' } } })
  })
})

describe('interakt driver', () => {
  const cfg = { driver: 'interakt' as const, interaktApiKey: 'k', interaktWebhookSecret: 'shh' }
  it('parses inbound text (country code + number → E.164 digits) and status events', () => {
    const d = makeInteraktDriver(cfg, noNetwork)
    const a = d.parseInbound(INTERAKT_TEXT)
    expect(a.messages[0]).toMatchObject({ vendorMessageId: 'int-msg-1', fromE164: '919876543210', kind: 'text', body: 'STOP' })
    const b = d.parseInbound(INTERAKT_DELIVERED)
    expect(b.statuses[0]).toMatchObject({ vendorMessageId: 'int-out-1', status: 'delivered' })
  })
  it('verifies the shared-secret header', () => {
    const d = makeInteraktDriver(cfg, noNetwork)
    expect(d.verifySignature('{}', { 'x-interakt-secret': 'shh' })).toBe(true)
    expect(d.verifySignature('{}', { 'x-interakt-secret': 'nope' })).toBe(false)
  })
})

describe('stub driver + env selection', () => {
  it('never touches the network and reports stub', async () => {
    const log = vi.fn()
    const d = makeStubDriver(log)
    const r = await d.sendTemplate('919876543210', 'amc_order_placed_en', 'en', ['a'])
    expect(r.detail).toBe('stub')
    expect(r.ok).toBe(true)
    expect(log).toHaveBeenCalled()
  })
  it('falls back to stub unless a driver AND its credentials are present', () => {
    expect(whatsappConfigFromEnv({}).driver).toBe('stub')
    expect(whatsappConfigFromEnv({ WHATSAPP_DRIVER: 'meta_cloud' }).driver).toBe('stub')
    expect(whatsappConfigFromEnv({ WHATSAPP_DRIVER: 'meta_cloud', WHATSAPP_PHONE_NUMBER_ID: 'p', WHATSAPP_ACCESS_TOKEN: 't' }).driver).toBe('meta_cloud')
    expect(whatsappConfigFromEnv({ WHATSAPP_DRIVER: 'interakt', INTERAKT_API_KEY: 'k' }).driver).toBe('interakt')
    expect(createWhatsAppProvider(whatsappConfigFromEnv({})).name).toBe('stub')
  })
})
