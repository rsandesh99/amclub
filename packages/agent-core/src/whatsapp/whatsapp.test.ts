import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MEDIA_LIMITS,
  MediaRefusedError,
  mediaLimitsFromEnv,
  mimeAllowed,
  pendingMediaRef,
  quotedVendorMessageId,
  WA_ALWAYS_ALLOWED_KINDS,
  WA_TEMPLATES,
  allTemplateNames,
  classifyKeyword,
  createWhatsAppProvider,
  makeMetaCloudDriver,
  makeStubDriver,
  metaVerifyChallenge,
  resolveTemplate,
  templateFor,
  whatsappConfigFromEnv,
  whatsappDriverState,
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
    metadata: { display_phone_number: '15550001111', phone_number_id: 'PNID' },
    messages: [{ from: '919876543210', id: 'wamid.IMG1', timestamp: '1726800100', type: 'image', image: { id: 'MEDIA123', mime_type: 'image/jpeg', caption: 'site photo' } }],
    statuses: [{ id: 'wamid.OUT1', status: 'delivered', timestamp: '1726800101', recipient_id: '919876543210' }],
  } }] }],
}
const noNetwork: typeof fetch = (async () => { throw new Error('network call attempted') }) as unknown as typeof fetch

describe('template registry', () => {
  it('covers every transactional kind in every locale and never an unknown one', () => {
    for (const k of ['order_placed', 'order_delivered', 'payout_paid', 'rfq_new_quote', 'milestone_added']) {
      expect(templateFor(k, 'hi')?.name).toMatch(/_hi$/)
      expect(resolveTemplate(k, 'te')).toMatchObject({ name: expect.stringMatching(/_te$/), language: 'te' })
      expect(resolveTemplate(k, 'ta')).toMatchObject({ name: expect.stringMatching(/_ta$/), language: 'ta' })
    }
    expect(templateFor('marketing_blast', 'en')).toBeNull()
    expect(allTemplateNames().length).toBe(new Set(allTemplateNames()).size)
  })
  it('S1.6 onboarding templates exist in en/hi/te/ta; expired carries the link as its URL button only', () => {
    for (const k of ['onboarding_start', 'onboarding_resume', 'onboarding_draft_ready', 'onboarding_expired']) {
      expect(templateFor(k, 'te')?.name).toMatch(/_te$/)
      expect(templateFor(k, 'hi')?.name).toMatch(/_hi$/)
    }
    const spec = templateFor('onboarding_expired', 'en')!.spec
    expect(spec.params({ link: 'https://amclub.in/partner/onboarding?session=s1' })).toEqual([])
    expect(spec.urlButton?.suffix({ link: 'https://amclub.in/partner/onboarding?session=s1' })).toBe('partner/onboarding?session=s1')
  })
  it('ADR-030: no kind is sendable without consent any more (the always-allowed set is gone)', () => {
    expect(WA_ALWAYS_ALLOWED_KINDS.size).toBe(0)
    for (const k of ['rfq_matched', 'review_prompt', 'order_placed']) expect(WA_TEMPLATES[k]?.category).toBe('utility')
    // the three system kinds move to templates-system.ts (the dispatcher's own copy)
    for (const k of ['wa_opt_in_confirmed', 'wa_opt_out_confirmed', 'wa_holding_reply']) expect(Object.keys(WA_TEMPLATES).includes(k) ? 'system' : 'absent').toMatch(/system|absent/)
  })
  it('deprecated keyword classifier still answers for its remaining callers', () => {
    expect(classifyKeyword(' Start ')).toBe('opt_in')
    expect(classifyKeyword('JOIN')).toBe('onboard')
    expect(classifyKeyword('STOP')).toBe('opt_out')
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
  it('parses an interactive list reply as a button with the row id as payload', () => {
    const d = makeMetaCloudDriver(cfg, noNetwork)
    const body = { entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PNID' }, messages: [{ from: '919876543210', id: 'wamid.LIST1', timestamp: '1726800200', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'cat:legal', title: 'Legal' } } }] } }] }] }
    expect(d.parseInbound(body).messages[0]).toMatchObject({ kind: 'button', buttonPayload: 'cat:legal', body: 'Legal' })
  })
  it('sends ≤ 3 buttons as an interactive button message and more as a list', async () => {
    const calls: { body: { type: string; interactive?: { type: string; action: Record<string, unknown> } } }[] = []
    const f: typeof fetch = (async (_url: string, init: RequestInit) => { calls.push({ body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ messages: [{ id: 'wamid.B' }] }), { status: 200 }) }) as unknown as typeof fetch
    const d = makeMetaCloudDriver(cfg, f)
    await d.sendButtons('919876543210', 'Confirm?', [{ id: 'confirm:r1', title: 'Looks right' }, { id: 'revise:r1', title: 'Change something' }])
    expect(calls[0]?.body.interactive?.type).toBe('button')
    await d.sendButtons('919876543210', 'Pick', Array.from({ length: 8 }, (_, i) => ({ id: `cat:${i}`, title: `Category ${i}` })), 'Choose')
    expect(calls[1]?.body.interactive?.type).toBe('list')
    expect((calls[1]?.body.interactive?.action['sections'] as { rows: unknown[] }[])[0]?.rows).toHaveLength(8)
  })
  it('sends a template with ordered body params', async () => {
    const calls: { url: string; body: unknown }[] = []
    const f: typeof fetch = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT9' }] }), { status: 200 }) }) as unknown as typeof fetch
    const d = makeMetaCloudDriver(cfg, f)
    const r = await d.sendTemplate('919876543210', { name: 'amc_order_placed_hi', language: 'hi' }, { body: ['Order placed', 'AMC-1'] })
    expect(r).toEqual({ ok: true, vendorMessageId: 'wamid.OUT9', detail: 'sent' })
    expect(calls[0]?.url).toContain('/v24.0/PNID/messages')
    expect(calls[0]?.body).toMatchObject({ type: 'template', template: { name: 'amc_order_placed_hi', language: { code: 'hi' } } })
    // the deprecated positional form takes the language from the name, never from the locale (audit B2)
    await d.sendTemplate('919876543210', 'amc_order_placed_en', 'te', ['x'])
    expect(calls[1]?.body).toMatchObject({ template: { name: 'amc_order_placed_en', language: { code: 'en' } } })
  })
})

describe('stub driver + env selection', () => {
  it('never touches the network and reports stub', async () => {
    const log = vi.fn()
    const d = makeStubDriver(log)
    const r = await d.sendTemplate('919876543210', { name: 'amc_order_placed_en', language: 'en' }, { body: ['a'] })
    expect(r.detail).toBe('stub')
    expect(r.ok).toBe(true)
    expect(log).toHaveBeenCalled()
  })
  it('falls back to stub unless a driver AND its credentials are present', () => {
    expect(whatsappConfigFromEnv({}).driver).toBe('stub')
    expect(whatsappConfigFromEnv({ WHATSAPP_DRIVER: 'meta_cloud' }).driver).toBe('stub')
    expect(whatsappConfigFromEnv({ WHATSAPP_DRIVER: 'meta_cloud', WHATSAPP_PHONE_NUMBER_ID: 'p', WHATSAPP_ACCESS_TOKEN: 't' }).driver).toBe('meta_cloud')
    expect(whatsappConfigFromEnv({ WHATSAPP_DRIVER: 'interakt', INTERAKT_API_KEY: 'k' }).driver).toBe('stub') // Interakt removed (ADR-030)
    expect(createWhatsAppProvider(whatsappConfigFromEnv({})).name).toBe('stub')
  })
  it('pins the Graph version (default v24.0; an invalid value is replaced and reported) and a timeout', () => {
    expect(whatsappConfigFromEnv({}).graphVersion).toBe('v24.0')
    expect(whatsappConfigFromEnv({ WHATSAPP_GRAPH_VERSION: 'v25.0' }).graphVersion).toBe('v25.0')
    expect(whatsappConfigFromEnv({ WHATSAPP_GRAPH_VERSION: 'latest' }).graphVersion).toBe('v24.0')
    expect(whatsappConfigFromEnv({}).timeoutMs).toBe(10_000)
    expect(whatsappConfigFromEnv({ WHATSAPP_TIMEOUT_MS: '4000' }).timeoutMs).toBe(4000)
    expect(whatsappDriverState({ WHATSAPP_GRAPH_VERSION: 'v20' }).invalid).toContain('WHATSAPP_GRAPH_VERSION')
  })
  it('fails loud: meta_cloud named without credentials is reported (names only, never values)', () => {
    const s = whatsappDriverState({ WHATSAPP_DRIVER: 'meta_cloud', WHATSAPP_ACCESS_TOKEN: 'secret-token' })
    expect(s).toMatchObject({ requested: 'meta_cloud', driver: 'stub', live: false, configured: false, tokenSet: true, phoneNumberIdSet: false })
    expect(s.missing).toEqual(['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'])
    expect(JSON.stringify(s)).not.toContain('secret-token')
    const ok = whatsappDriverState({ WHATSAPP_DRIVER: 'meta_cloud', WHATSAPP_PHONE_NUMBER_ID: 'p', WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_APP_SECRET: 'a', WHATSAPP_VERIFY_TOKEN: 'v', WHATSAPP_WABA_ID: 'w' })
    expect(ok).toMatchObject({ driver: 'meta_cloud', live: true, configured: true, wabaIdSet: true, missing: [] })
    expect(whatsappDriverState({})).toMatchObject({ driver: 'stub', requested: 'stub', configured: true })
  })
})

// ── audit M34: bounded media downloads (the wa.inbound job, never the webhook) ──
describe('downloadMedia limits (audit M34)', () => {
  const cfg = { driver: 'meta_cloud' as const, phoneNumberId: 'PNID', accessToken: 'tok', appSecret: 'app-secret', verifyToken: 'vt' }
  const limits = { ...DEFAULT_MEDIA_LIMITS, maxBytes: 1024 }
  /** A Graph lookup answer, then the binary response the test supplies. */
  function metaFetch(lookup: Record<string, unknown>, bin: () => Response): { f: typeof fetch; urls: string[] } {
    const urls: string[] = []
    const f = (async (url: string) => {
      urls.push(url)
      if (url.includes('/MEDIA')) return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/x', ...lookup }), { status: 200 })
      return bin()
    }) as unknown as typeof fetch
    return { f, urls }
  }
  function streamOf(total: number, chunk = 256): ReadableStream<Uint8Array> {
    let sent = 0
    return new ReadableStream({
      pull(c) {
        if (sent >= total) {
          c.close()
          return
        }
        const n = Math.min(chunk, total - sent)
        sent += n
        c.enqueue(new Uint8Array(n))
      },
    })
  }

  it('downloads an allowed type under the cap', async () => {
    const { f } = metaFetch({ mime_type: 'image/jpeg', file_size: 500 }, () => new Response(new Uint8Array(500), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    const r = await makeMetaCloudDriver(cfg, f).downloadMedia('MEDIA1', limits)
    expect(r.bytes.byteLength).toBe(500)
    expect(r.mime).toBe('image/jpeg')
  })
  it('refuses a disallowed MIME before downloading any bytes', async () => {
    const { f, urls } = metaFetch({ mime_type: 'video/mp4', file_size: 10 }, () => new Response('x'))
    await expect(makeMetaCloudDriver(cfg, f).downloadMedia('MEDIA2', limits)).rejects.toMatchObject({ code: 'mime_not_allowed' })
    expect(urls).toHaveLength(1)
  })
  it('refuses a declared size over the cap (Graph file_size, then Content-Length)', async () => {
    const a = metaFetch({ mime_type: 'image/png', file_size: 5000 }, () => new Response('x'))
    await expect(makeMetaCloudDriver(cfg, a.f).downloadMedia('MEDIA3', limits)).rejects.toMatchObject({ code: 'too_large' })
    expect(a.urls).toHaveLength(1)
    const b = metaFetch({ mime_type: 'image/png' }, () => new Response(streamOf(10), { status: 200, headers: { 'content-length': '999999' } }))
    await expect(makeMetaCloudDriver(cfg, b.f).downloadMedia('MEDIA4', limits)).rejects.toMatchObject({ code: 'too_large' })
  })
  it('caps the STREAM when Content-Length is missing or lies', async () => {
    const { f } = metaFetch({ mime_type: 'audio/ogg' }, () => new Response(streamOf(4096), { status: 200, headers: { 'content-length': '100' } }))
    await expect(makeMetaCloudDriver(cfg, f).downloadMedia('MEDIA5', limits)).rejects.toMatchObject({ code: 'too_large' })
  })
  it('times out a slow vendor', async () => {
    const slow = (async (_url: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))
      })) as unknown as typeof fetch
    await expect(makeMetaCloudDriver(cfg, slow).downloadMedia('MEDIA6', { ...limits, timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout' })
  })
  it('refuses a malformed media id', async () => {
    await expect(makeMetaCloudDriver(cfg, noNetwork).downloadMedia('../../etc', limits)).rejects.toBeInstanceOf(MediaRefusedError)
  })
  it('media limits come from env, clamped; the allow-list is code', () => {
    expect(mediaLimitsFromEnv({}).maxBytes).toBe(DEFAULT_MEDIA_LIMITS.maxBytes)
    expect(mediaLimitsFromEnv({ WA_MEDIA_MAX_BYTES: '2097152' }).maxBytes).toBe(2097152)
    expect(mediaLimitsFromEnv({ WA_MEDIA_MAX_BYTES: '999999999999' }).maxBytes).toBe(DEFAULT_MEDIA_LIMITS.maxBytes)
    expect(mimeAllowed('audio/ogg; codecs=opus')).toBe(true)
    expect(mimeAllowed('image/svg+xml')).toBe(false)
  })
  it('reads the quoted message id and the pending media ref from a stored payload', () => {
    expect(quotedVendorMessageId({ context: { id: 'wamid.OUT7' } })).toBe('wamid.OUT7')
    expect(quotedVendorMessageId({})).toBeNull()
    expect(pendingMediaRef({ amc_media_ref: 'MEDIA9' })).toBe('MEDIA9')
    expect(pendingMediaRef({ image: { id: 'x' } })).toBeNull()
  })
})
