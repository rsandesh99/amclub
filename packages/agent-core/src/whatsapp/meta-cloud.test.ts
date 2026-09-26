import { describe, expect, it } from 'vitest'
import {
  buildTemplateComponents,
  classifyWaError,
  cleanTemplateParam,
  makeMetaCloudDriver,
  parseGraphError,
  parseMetaWebhook,
  waErrorTripsBreaker,
  waMessageCostMillipaise,
} from './index'

/** ADR-030 §1 / §3, audit B5 / B6 / B7 / 2.9 and the "smaller must-fix" items — the Meta driver and the webhook parser. */

const cfg = { driver: 'meta_cloud' as const, phoneNumberId: 'PNID', accessToken: 'tok', appSecret: 's', verifyToken: 'v', wabaId: 'WABA1' }
type Call = { url: string; init: RequestInit; body: unknown }
function recorder(respond: (url: string) => Response = () => new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT' }] }), { status: 200 })) {
  const calls: Call[] = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
    return respond(url)
  }) as unknown as typeof fetch
  return { f, calls }
}
const change = (value: Record<string, unknown>, field = 'messages') => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [{ field, value }] }] })
const OURS = { metadata: { display_phone_number: '15550001111', phone_number_id: 'PNID' } }

describe('template parameters are cleaned (Meta refuses newlines, tabs, 4+ spaces, empty)', () => {
  it('newlines / tabs → a space, 4+ spaces → one, trimmed, never empty, ≤ 1024 chars', () => {
    expect(cleanTemplateParam('Line one\nLine two\r\n\tthree')).toBe('Line one Line two three')
    expect(cleanTemplateParam('a     b')).toBe('a b')
    expect(cleanTemplateParam('a   b')).toBe('a   b')
    expect(cleanTemplateParam('')).toBe('-')
    expect(cleanTemplateParam(null)).toBe('-')
    expect(cleanTemplateParam('   \n ')).toBe('-')
    const long = cleanTemplateParam('x'.repeat(5000))
    expect(Array.from(long).length).toBe(1024)
    // never splits an emoji
    expect(cleanTemplateParam('😀'.repeat(2000)).endsWith('…')).toBe(true)
  })
  it('builds body params, the URL button (index 0, sub_type url) and quick replies', () => {
    const c = buildTemplateComponents({ body: ['Order\nplaced', ''], urlButton: { suffix: '/app/orders/1' }, quickReplies: [{ payload: 'STOP' }] })
    expect(c).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Order placed' }, { type: 'text', text: '-' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'app/orders/1' }] },
      { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'STOP' }] },
    ])
  })
})

describe('meta_cloud sends', () => {
  it('sends a template with its components under the pinned version', async () => {
    const { f, calls } = recorder()
    const d = makeMetaCloudDriver({ ...cfg, graphVersion: 'v25.0' }, f)
    const r = await d.sendTemplate('919876543210', { name: 'amc_order_placed_te', language: 'te' }, { body: ['A', 'B'], urlButton: { suffix: 'app/orders/9' } })
    expect(r.ok).toBe(true)
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v25.0/PNID/messages')
    expect(calls[0]!.body).toMatchObject({ type: 'template', template: { name: 'amc_order_placed_te', language: { code: 'te' }, components: [{ type: 'body' }, { type: 'button', sub_type: 'url', index: '0' }] } })
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })
  it('sends an interactive cta_url (https only), marks read with typing, and sends media by link with a document filename', async () => {
    const { f, calls } = recorder()
    const d = makeMetaCloudDriver(cfg, f)
    await d.sendCtaUrl('919876543210', 'Your invoice is ready', 'Open invoice in AMClub', 'https://amclub.in/app/orders/1')
    expect(calls[0]!.body).toMatchObject({ type: 'interactive', interactive: { type: 'cta_url', action: { name: 'cta_url', parameters: { display_text: 'Open invoice in AMCl', url: 'https://amclub.in/app/orders/1' } } } })
    expect((await d.sendCtaUrl('919876543210', 'x', 'y', 'http://evil.example')).ok).toBe(false)
    await d.markRead('wamid.IN1', true)
    expect(calls[1]!.body).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN1', typing_indicator: { type: 'text' } })
    await d.sendMedia('919876543210', { url: 'https://amclub.in/f.pdf', mime: 'application/pdf', caption: 'Invoice', filename: 'AMC-1-invoice.pdf' })
    expect(calls[2]!.body).toMatchObject({ type: 'document', document: { link: 'https://amclub.in/f.pdf', caption: 'Invoice', filename: 'AMC-1-invoice.pdf' } })
  })
  it('uploads media bytes first (multipart POST /{phone-number-id}/media) and sends by id', async () => {
    const { f, calls } = recorder((url) => (url.endsWith('/media') ? new Response(JSON.stringify({ id: 'MEDIA77' }), { status: 200 }) : new Response(JSON.stringify({ messages: [{ id: 'wamid.M' }] }), { status: 200 })))
    const d = makeMetaCloudDriver(cfg, f)
    const r = await d.sendMedia('919876543210', { bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg', caption: 'photo' })
    expect(r).toMatchObject({ ok: true, vendorMessageId: 'wamid.M' })
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v24.0/PNID/media')
    expect(calls[0]!.init.body).toBeInstanceOf(FormData)
    expect(calls[1]!.body).toMatchObject({ type: 'image', image: { id: 'MEDIA77', caption: 'photo' } })
  })
  it('parses a Graph error (code, subcode, title) instead of flattening it', async () => {
    const { f } = recorder(() => new Response(JSON.stringify({ error: { message: '(#131047) Re-engagement message', code: 131047, error_subcode: 2494010, error_data: { details: 'More than 24 hours' } } }), { status: 400 }))
    const r = await makeMetaCloudDriver(cfg, f).sendText('919876543210', 'hi')
    expect(r.ok).toBe(false)
    expect(r.error).toMatchObject({ code: 131047, subcode: 2494010, httpStatus: 400 })
    expect(r.detail).toContain('131047')
  })
  it('times out a slow Graph call (network error, retryable)', async () => {
    const slow = (async (_u: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))))) as unknown as typeof fetch
    const r = await makeMetaCloudDriver({ ...cfg, timeoutMs: 20 }, slow).sendText('919876543210', 'hi')
    expect(r.ok).toBe(false)
    expect(r.error).toMatchObject({ code: null, httpStatus: null })
    expect(classifyWaError(r.error!.code, r.error!.httpStatus)).toEqual({ kind: 'network', retryable: true })
  })
})

describe('classifyWaError', () => {
  it('maps the codes the send path acts on', () => {
    expect(classifyWaError(131047, 400)).toEqual({ kind: 'outside_window', retryable: false })
    expect(classifyWaError(131026, 400)).toEqual({ kind: 'not_on_whatsapp', retryable: false })
    expect(classifyWaError(131050, 400)).toEqual({ kind: 'user_stopped_marketing', retryable: false })
    expect(classifyWaError(131049, 400)).toEqual({ kind: 'marketing_limit', retryable: false })
    expect(classifyWaError(130429, 400)).toEqual({ kind: 'rate_limited', retryable: true })
    expect(classifyWaError(131056, 400)).toEqual({ kind: 'rate_limited', retryable: true })
    expect(classifyWaError(368, 400)).toEqual({ kind: 'account_restricted', retryable: false })
    expect(classifyWaError(131031, 400)).toEqual({ kind: 'account_restricted', retryable: false })
    expect(classifyWaError(190, 401)).toEqual({ kind: 'auth', retryable: false })
    expect(classifyWaError(132001, 404)).toEqual({ kind: 'template', retryable: false })
  })
  it('falls back on the HTTP status for an unknown or absent code', () => {
    expect(classifyWaError(null, 503)).toEqual({ kind: 'server', retryable: true })
    expect(classifyWaError(999999, 500)).toEqual({ kind: 'server', retryable: true })
    expect(classifyWaError(null, 429)).toEqual({ kind: 'rate_limited', retryable: true })
    expect(classifyWaError(null, null)).toEqual({ kind: 'network', retryable: true })
    expect(classifyWaError(999999, 400)).toEqual({ kind: 'invalid', retryable: false })
  })
  it('only account restrictions and auth failures trip the breaker', () => {
    expect(waErrorTripsBreaker('account_restricted')).toBe(true)
    expect(waErrorTripsBreaker('auth')).toBe(true)
    expect(waErrorTripsBreaker('rate_limited')).toBe(false)
    expect(waErrorTripsBreaker('not_on_whatsapp')).toBe(false)
  })
  it('parseGraphError tolerates junk', () => {
    expect(parseGraphError(null, 502)).toMatchObject({ code: null, title: 'http_502', httpStatus: 502 })
    expect(parseGraphError({ error: { code: '131026', error_user_title: 'Message undeliverable' } }, 400)).toMatchObject({ code: 131026, title: 'Message undeliverable' })
  })
})

describe('parseInbound (Meta webhook)', () => {
  const d = makeMetaCloudDriver(cfg, (async () => new Response('{}')) as unknown as typeof fetch)
  it('keeps a business-scoped user id as is — never reduced to digits (audit 2.9)', () => {
    const p = d.parseInbound(change({ ...OURS, contacts: [{ profile: { name: 'R' }, user_id: 'IN.9187xyz' }], messages: [{ from: 'IN.9187xyz', id: 'wamid.B1', timestamp: '1726800000', type: 'text', text: { body: 'hi' } }] }))
    expect(p.messages[0]).toMatchObject({ fromE164: null, bsuid: 'IN.9187xyz', kind: 'text', body: 'hi' })
    const q = d.parseInbound(change({ ...OURS, messages: [{ from: '919876543210', user_id: 'IN.abc', id: 'wamid.B2', timestamp: '1726800000', type: 'text', text: { body: 'x' } }] }))
    expect(q.messages[0]).toMatchObject({ fromE164: '919876543210', bsuid: 'IN.abc' })
    const r = d.parseInbound(change({ ...OURS, messages: [{ from: '', id: 'wamid.B3', timestamp: '1', type: 'text', text: { body: 'x' } }] }))
    expect(r.messages).toHaveLength(0)
  })
  it('reads the ad referral, the quoted message, a reaction and a location', () => {
    const p = d.parseInbound(change({
      ...OURS,
      messages: [
        { from: '919876543210', id: 'wamid.R1', timestamp: '1726800000', type: 'text', text: { body: 'Is this available?' }, context: { id: 'wamid.OUT7' }, referral: { source_url: 'https://fb.me/ad', source_id: 'AD1', source_type: 'ad', headline: 'GST filing', ctwa_clid: 'CLID' } },
        { from: '919876543210', id: 'wamid.R2', timestamp: '1726800001', type: 'reaction', reaction: { message_id: 'wamid.OUT8', emoji: '👍' } },
        { from: '919876543210', id: 'wamid.R3', timestamp: '1726800002', type: 'location', location: { latitude: 17.4, longitude: 78.5, name: 'Shop', address: 'Ameerpet' } },
      ],
    }))
    expect(p.messages[0]).toMatchObject({ contextId: 'wamid.OUT7', referral: { sourceId: 'AD1', sourceType: 'ad', headline: 'GST filing', ctwaClid: 'CLID' } })
    expect(p.messages[1]).toMatchObject({ kind: 'reaction', body: '👍', contextId: 'wamid.OUT8' })
    expect(p.messages[2]).toMatchObject({ kind: 'location', body: 'Shop, Ameerpet' })
  })
  it('maps system (user changed number, with the new wa_id), a Flow reply, video, sticker, contacts, order', () => {
    const p = d.parseInbound(change({
      ...OURS,
      messages: [
        { from: '919876543210', id: 'wamid.S1', timestamp: '1', type: 'system', system: { body: 'User changed from 919876543210 to 919999988888', new_wa_id: '919999988888', type: 'user_changed_number' } },
        { from: '919876543210', id: 'wamid.F1', timestamp: '2', type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: '{"address":"Plot 4","flow_token":"t1"}' } } },
        { from: '919876543210', id: 'wamid.V1', timestamp: '3', type: 'video', video: { id: 'VID1', mime_type: 'video/mp4', caption: 'site' } },
        { from: '919876543210', id: 'wamid.K1', timestamp: '4', type: 'sticker', sticker: { id: 'STK1', mime_type: 'image/webp' } },
        { from: '919876543210', id: 'wamid.C1', timestamp: '5', type: 'contacts', contacts: [{ name: { formatted_name: 'A' } }] },
        { from: '919876543210', id: 'wamid.O1', timestamp: '6', type: 'order', order: { catalog_id: 'c', text: 'please deliver', product_items: [] } },
        { from: '919876543210', id: 'wamid.U1', timestamp: '7', type: 'unsupported' },
      ],
    }))
    expect(p.messages.map((m) => m.kind)).toEqual(['system', 'flow_reply', 'video', 'sticker', 'contacts', 'order', 'unknown'])
    expect(p.messages[0]).toMatchObject({ newWaId: '919999988888' })
    expect(p.messages[1]).toMatchObject({ flowResponse: { address: 'Plot 4', flow_token: 't1' }, body: 'Sent' })
    expect(p.messages[2]).toMatchObject({ mediaRef: 'VID1', mime: 'video/mp4', body: 'site' })
  })
  it('statuses carry errors[0] and the pricing object', () => {
    const p = d.parseInbound(change({
      ...OURS,
      statuses: [
        { id: 'wamid.OUT1', status: 'delivered', timestamp: '1726800101', recipient_id: '919876543210', pricing: { billable: true, pricing_model: 'PMP', category: 'utility', type: 'regular' } },
        { id: 'wamid.OUT2', status: 'failed', timestamp: '1726800102', recipient_id: '919876543210', errors: [{ code: 131026, title: 'Message undeliverable' }] },
        { id: 'wamid.OUT3', status: 'deleted', timestamp: '1726800103' },
      ],
    }))
    expect(p.statuses).toHaveLength(2)
    expect(p.statuses[0]).toMatchObject({ status: 'delivered', pricing: { billable: true, category: 'utility', pricingModel: 'PMP', type: 'regular' }, errorCode: null })
    expect(p.statuses[1]).toMatchObject({ status: 'failed', errorCode: 131026, errorTitle: 'Message undeliverable', pricing: null })
  })
  it('returns account-level fields, and drops entries for another phone number id or WABA', () => {
    const body = {
      entry: [
        { id: 'WABA1', changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_name: 'amc_order_placed_te', message_template_language: 'te' } }] },
        { id: 'WABA1', changes: [{ field: 'template_category_update', value: { message_template_name: 'amc_review_prompt_en', new_category: 'MARKETING' } }] },
        { id: 'WABA1', changes: [{ field: 'phone_number_quality_update', value: { event: 'FLAGGED' } }] },
        { id: 'OTHER_WABA', changes: [{ field: 'account_update', value: { event: 'X' } }] },
        { id: 'WABA1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'SECOND_NUMBER' }, messages: [{ from: '919876543210', id: 'wamid.X', timestamp: '1', type: 'text', text: { body: 'x' } }], statuses: [{ id: 'wamid.Y', status: 'read', timestamp: '1' }] } }] },
        { id: 'WABA1', changes: [{ field: 'messages', value: { messages: [{ from: '919876543210', id: 'wamid.Z', timestamp: '1', type: 'text', text: { body: 'no metadata' } }] } }] },
      ],
    }
    const p = d.parseInbound(body)
    expect(p.account.map((a) => a.field)).toEqual(['message_template_status_update', 'template_category_update', 'phone_number_quality_update'])
    expect(p.account[0]).toMatchObject({ entryId: 'WABA1', value: { event: 'APPROVED' } })
    expect(p.messages).toHaveLength(0)
    expect(p.statuses).toHaveLength(0)
    expect(p.dropped).toBe(4)
  })
  it('without a configured phone number id (the stub, dev fixtures) nothing is dropped', () => {
    const p = parseMetaWebhook(change({ messages: [{ from: '919876543210', id: 'wamid.D1', timestamp: '1', type: 'text', text: { body: 'x' } }] }), { phoneNumberId: null, wabaId: null })
    expect(p.messages).toHaveLength(1)
    expect(p.dropped).toBe(0)
  })
})

describe('cost in millipaise (integers, rule 6)', () => {
  it('billable utility / marketing / service at the registry rate; free tiers cost 0; unknown category null', () => {
    expect(waMessageCostMillipaise({ billable: true, category: 'utility', pricingModel: 'PMP', type: 'regular' })).toBe(11_500)
    expect(waMessageCostMillipaise({ billable: true, category: 'marketing', pricingModel: 'PMP', type: 'regular' })).toBe(86_310)
    expect(waMessageCostMillipaise({ billable: false, category: 'service', pricingModel: 'PMP', type: 'free_customer_service' })).toBe(0)
    expect(waMessageCostMillipaise({ billable: null, category: 'utility', pricingModel: 'PMP', type: 'free_entry_point' })).toBe(0)
    expect(waMessageCostMillipaise({ billable: true, category: 'authentication_international', pricingModel: 'PMP', type: 'regular' })).toBeNull()
    expect(waMessageCostMillipaise(null)).toBeNull()
    expect(waMessageCostMillipaise({ billable: true, category: 'utility', pricingModel: null, type: null }, { utility: 12_000 })).toBe(12_000)
  })
})
