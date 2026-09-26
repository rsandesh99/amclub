/**
 * verify-whatsapp — the WhatsApp transport kill-test (ADR-030; verify-* convention).
 *
 * OFFLINE (always, no network, no DB writes — an in-memory PostgREST stand-in drives the send path):
 *   - Meta driver: X-Hub-Signature-256 rejects a tampered body / wrong secret; a replayed webhook maps to the same
 *     vendor_message_id; a second phone number id / WABA is dropped; a business-scoped id is never reduced to digits;
 *     the Graph version is pinned (v24.0 default, an invalid value replaced) and a named driver without credentials
 *     is reported (names only); the stub never calls the network; Interakt is gone.
 *   - templates: an unknown kind resolves to nothing; every locale resolves to its own (name, language) pair and a
 *     locale without a variant goes as the en name WITH the en code (audit B2); template parameters are cleaned.
 *   - errors: Graph codes classified (131047 / 131026 / 131050 / 131049 / 130429 / 368 …).
 *   - the one send path (`sendWhatsApp`): no opt-in → skipped; STOP → nothing but the one confirmation; a reply in
 *     the window needs no opt-in; outside the window only a template; the ledger row is written before the call and a
 *     repeated key is a duplicate; 131047 → retried as the template; 131026 → suppression; before 0086 the old rule.
 *   - consent keywords: a greeting is not consent, "no" / "cancel" are not STOP (shared classifyWaKeyword).
 *
 * LIVE (BASE_URL to a running dark server): /api/v1/agent/grants 404s while AGENT_ENABLED=false (the opt-in surface
 * is inert). The runtime webhook is not exercised here (it runs on Fly); docs/agents/WHATSAPP.md covers the Meta
 * test-number flow. Zero prod residue.
 * Run: [BASE_URL=<url>] pnpm --filter @amclub/web whatsapp:verify
 */
import { createHmac } from 'node:crypto'
import {
  WA_ALWAYS_ALLOWED_KINDS,
  classifyWaError,
  cleanTemplateParam,
  createWhatsAppProvider,
  makeMetaCloudDriver,
  resetWaSendStateForTests,
  resolveTemplate,
  sendWhatsApp,
  whatsappConfigFromEnv,
  whatsappDriverState,
  type SendResult,
  type WaSendRequest,
  type WhatsAppProvider,
} from '@amclub/agent-core'
import { classifyWaKeyword } from '@amclub/shared'
import { fakeDb } from '../../../packages/agent-core/src/whatsapp/testing/fake-db'

const BASE_URL = process.env['BASE_URL'] || ''
type Status = 'pass' | 'FAIL' | 'skip'
const rows: { name: string; status: Status; detail?: string }[] = []
let failed = 0
const record = (name: string, status: Status, detail?: string) => { rows.push({ name, status, ...(detail ? { detail } : {}) }); if (status === 'FAIL') failed++ }
const check = (name: string, ok: boolean, detail?: string) => record(name, ok ? 'pass' : 'FAIL', detail)

const META = { object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'p' }, messages: [{ from: '919876543210', id: 'wamid.REPLAY1', timestamp: '1726800000', type: 'text', text: { body: 'START' } }] } }] }] }
const noNet: typeof fetch = (async () => { throw new Error('network call attempted') }) as unknown as typeof fetch

async function driver() {
  const meta = makeMetaCloudDriver({ driver: 'meta_cloud', phoneNumberId: 'p', accessToken: 't', appSecret: 'sekrit', wabaId: 'WABA1' }, noNet)
  const raw = JSON.stringify(META)
  const sig = 'sha256=' + createHmac('sha256', 'sekrit').update(raw).digest('hex')
  check('meta signature: valid body accepted', meta.verifySignature(raw, { 'x-hub-signature-256': sig }))
  check('meta signature: tampered body rejected', !meta.verifySignature(raw.replace('START', 'STOP'), { 'x-hub-signature-256': sig }))
  check('meta signature: wrong secret rejected', !makeMetaCloudDriver({ driver: 'meta_cloud', appSecret: 'other' }, noNet).verifySignature(raw, { 'x-hub-signature-256': sig }))
  const a = meta.parseInbound(META), b = meta.parseInbound(JSON.parse(raw))
  check('inbound idempotency key stable across replay', a.messages[0]?.vendorMessageId === 'wamid.REPLAY1' && b.messages[0]?.vendorMessageId === a.messages[0]?.vendorMessageId)
  const foreign = meta.parseInbound({ entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'OTHER' }, messages: META.entry[0]!.changes[0]!.value.messages } }] }, { id: 'WABA2', changes: [{ field: 'account_update', value: {} }] }] })
  check('another phone number id / WABA is dropped, never ingested', foreign.messages.length === 0 && foreign.account.length === 0 && foreign.dropped === 2)
  const bsuid = meta.parseInbound({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'p' }, messages: [{ from: 'IN.9876543210', id: 'wamid.B', timestamp: '1', type: 'text', text: { body: 'x' } }] } }] }] })
  check('a business-scoped id is kept as is (never reduced to digits)', bsuid.messages[0]?.fromE164 === null && bsuid.messages[0]?.bsuid === 'IN.9876543210')
  const stub = createWhatsAppProvider(whatsappConfigFromEnv({}), noNet)
  const r = await stub.sendTemplate('919876543210', { name: 'amc_order_placed_en', language: 'en' }, { body: ['x'] }).catch((e: Error) => ({ ok: false, detail: e.message, vendorMessageId: null }))
  check('stub driver never calls the network', stub.name === 'stub' && r.detail === 'stub')
  check('Graph version pinned: v24.0 by default, an invalid value replaced', whatsappConfigFromEnv({}).graphVersion === 'v24.0' && whatsappConfigFromEnv({ WHATSAPP_GRAPH_VERSION: 'v20' }).graphVersion === 'v24.0')
  const st = whatsappDriverState({ WHATSAPP_DRIVER: 'meta_cloud', WHATSAPP_ACCESS_TOKEN: 'secret-token' })
  check('fail loud: meta_cloud without credentials is reported by name (no values)', !st.configured && st.missing.includes('WHATSAPP_PHONE_NUMBER_ID') && !JSON.stringify(st).includes('secret-token'))
  check('Interakt is gone (WHATSAPP_DRIVER=interakt reads as stub)', whatsappConfigFromEnv({ WHATSAPP_DRIVER: 'interakt', INTERAKT_API_KEY: 'k' }).driver === 'stub')
}

function templates() {
  check('unknown kind can never reach the vendor', resolveTemplate('marketing_blast', 'en') === null)
  const te = resolveTemplate('order_accepted', 'te'), ta = resolveTemplate('order_accepted', 'ta')
  check('te / ta go under their own language (audit B2)', te?.name === 'amc_order_accepted_te' && te.language === 'te' && ta?.name === 'amc_order_accepted_ta' && ta.language === 'ta')
  const only = resolveTemplate('x', 'te', { x: { stem: 'amc_x', category: 'utility', locales: ['en', 'hi'], body: { en: 'A {{1}} b.', hi: 'क {{1}} ख।' }, params: () => ['1'] } })
  check('a locale without a variant → the en name WITH the en code', only?.name === 'amc_x_en' && only.language === 'en')
  check('template parameters cleaned (newlines, 4+ spaces, empty)', cleanTemplateParam('a\nb     c') === 'a b c' && cleanTemplateParam('') === '-')
  check('no kind is sendable without consent (WA_ALWAYS_ALLOWED_KINDS empty)', WA_ALWAYS_ALLOWED_KINDS.size === 0)
  check('Graph errors classified', classifyWaError(131047, 400).kind === 'outside_window' && classifyWaError(131026, 400).kind === 'not_on_whatsapp' && classifyWaError(131050, 400).kind === 'user_stopped_marketing' && classifyWaError(131049, 400).kind === 'marketing_limit' && classifyWaError(130429, 400).retryable && classifyWaError(368, 403).kind === 'account_restricted' && !classifyWaError(368, 403).retryable)
  check('keywords: a greeting is not consent; "no" / "cancel" are not STOP', classifyWaKeyword('hi')?.intent === 'greeting' && classifyWaKeyword('no') === null && classifyWaKeyword('cancel') === null && classifyWaKeyword('STOP')?.intent === 'stop' && classifyWaKeyword('நிறுத்து')?.intent === 'stop')
}

// ── the one send path, against an in-memory database ─────────────────────────
const NOW = new Date('2026-10-02T10:00:00Z')
const PHONE = '919876543210'
const UNIQUE = { wa_messages: ['idempotency_key', 'vendor_message_id'], wa_conversations: ['phone_e164'] }
function world(window: 'open' | 'closed', consents: Array<[string, string]> = [], opts: Parameters<typeof fakeDb>[1] = { unique: UNIQUE }) {
  return fakeDb({
    wa_conversations: [{ id: 'c1', phone_e164: PHONE, user_id: 'u1', locale: 'en', window_open_until: new Date(NOW.getTime() + (window === 'open' ? 1 : -1) * 3600_000).toISOString() }],
    wa_messages: [],
    wa_phone_consents: consents.map(([purpose, status]) => ({ phone_e164: PHONE, purpose, status, updated_at: '2026-09-25T00:00:00.000Z' })),
    wa_suppressions: [],
    wa_templates: [],
  }, opts)
}
function vendor(plan: Array<Partial<SendResult>> = []): { p: WhatsAppProvider; calls: string[] } {
  const calls: string[] = []
  const go = async (m: string): Promise<SendResult> => {
    calls.push(m)
    return { ok: true, vendorMessageId: `wamid.O${calls.length}`, detail: 'sent', ...(plan[calls.length - 1] ?? {}) }
  }
  return { calls, p: { name: 'meta_cloud', sendTemplate: () => go('template'), sendText: () => go('text'), sendButtons: () => go('buttons'), sendCtaUrl: () => go('cta_url'), sendMedia: () => go('media'), markRead: () => go('read') } as unknown as WhatsAppProvider }
}
const fail = (code: number): Partial<SendResult> => ({ ok: false, vendorMessageId: null, detail: `error:${code}`, error: { code, subcode: null, title: String(code), message: String(code), httpStatus: 400 } })
const notify = (key: string): WaSendRequest => ({ phoneE164: `+${PHONE}`, userId: 'u1', purpose: 'transactional', initiation: 'business', kind: 'order_accepted', body: { type: 'template', kind: 'order_accepted', locale: 'te', values: { title: 't', body: 'b', link: '/app/orders/1' } }, idempotencyKey: key })
const answer = (key: string, fallback = true): WaSendRequest => ({ phoneE164: PHONE, conversationId: 'c1', userId: 'u1', purpose: 'assistant', initiation: 'reply', kind: 'support_reply', body: { type: 'text', text: 'In progress.' }, ...(fallback ? { fallbackTemplate: { type: 'template', kind: 'support_reply', locale: 'en', values: { title: 'x', body: 'y' } } } : {}), idempotencyKey: key })
const settings = async () => 120

async function sendPath() {
  const run = async (db: ReturnType<typeof world>, p: WhatsAppProvider, req: WaSendRequest) => sendWhatsApp({ db: db.client, provider: p, now: () => NOW, settings }, req)
  resetWaSendStateForTests()
  let v = vendor()
  const none = await run(world('open'), v.p, notify('n1'))
  check('no opt-in → skipped no_consent (nothing sent)', none.outcome === 'skipped' && none.reason === 'no_consent' && v.calls.length === 0)
  const stopped = world('open', [['transactional', 'opted_out'], ['assistant', 'opted_out'], ['marketing', 'opted_out']])
  const s1 = await run(stopped, v.p, notify('n2')), s2 = await run(stopped, v.p, answer('in1'))
  const conf = await run(stopped, v.p, { ...answer('stop1', false), kind: 'wa_opt_out_confirmed', purpose: 'transactional' })
  const conf2 = await run(stopped, v.p, { ...answer('stop1b', false), kind: 'wa_opt_out_confirmed', purpose: 'transactional' })
  check('STOP: nothing on WhatsApp but the one opt-out confirmation', s1.reason === 'opted_out' && s2.reason === 'opted_out' && conf.outcome === 'sent' && conf2.reason === 'opted_out' && v.calls.length === 1)
  v = vendor()
  const r = await run(world('open'), v.p, answer('in2'))
  check('a reply inside the window needs no opt-in', r.outcome === 'sent' && v.calls[0] === 'text')
  const outside = await run(world('closed', [['assistant', 'opted_in']]), vendor().p, { ...answer('in3', false), initiation: 'business' })
  const lateReply = await run(world('closed'), vendor().p, answer('in3b'))
  const outsideOpt = world('closed', [['assistant', 'opted_in']])
  v = vendor()
  const tmpl = await run(outsideOpt, v.p, { ...answer('in4'), initiation: 'business' })
  check('outside the window: only a template (none given → skipped outside_window)', outside.reason === 'outside_window')
  check('a "reply" after the window closed is business-initiated (needs the opt-in)', lateReply.reason === 'no_consent')
  check('outside the window with an opt-in: the fallback template goes', tmpl.outcome === 'sent' && tmpl.usedTemplate === true && v.calls[0] === 'template')
  const led = world('open', [['transactional', 'opted_in']])
  v = vendor()
  const first = await run(led, v.p, notify('n3')), again = await run(led, v.p, notify('n3'))
  const row = led.tables['wa_messages']![0]!
  check('ledger row before the call; the same key is a duplicate', first.outcome === 'sent' && again.outcome === 'duplicate' && v.calls.length === 1 && row['idempotency_key'] === 'n3' && row['template_language'] === 'te' && row['status'] === 'sent' && led.calls.filter((c) => c.table === 'wa_messages').map((c) => c.op).slice(0, 2).join() === 'insert,update')
  v = vendor([fail(131047)])
  const w = world('open', [['assistant', 'opted_in']])
  const retried = await run(w, v.p, answer('in5'))
  check('131047 → retried once as the fallback template', retried.outcome === 'sent' && retried.usedTemplate === true && v.calls.join() === 'text,template')
  const sup = world('open', [['transactional', 'opted_in']])
  await run(sup, vendor([fail(131026)]).p, notify('n4'))
  const after = await run(sup, vendor().p, notify('n5'))
  check('131026 → suppression not_on_whatsapp; the next send is skipped', sup.tables['wa_suppressions']![0]?.['reason'] === 'not_on_whatsapp' && after.reason === 'suppressed')
  resetWaSendStateForTests()
  const legacy = world('open', [], { unique: UNIQUE, missingTables: ['wa_phone_consents', 'wa_suppressions', 'wa_templates'], missingColumns: { wa_messages: ['idempotency_key', 'user_id', 'notification_kind', 'notification_id', 'run_id', 'template_language', 'category', 'status_at', 'error_code', 'error_title'] } })
  const l1 = await run(legacy, vendor().p, notify('n6'))
  const l2 = await run(legacy, vendor().p, { ...notify('n7'), kind: 'rfq_matched', body: { type: 'template', kind: 'rfq_matched', locale: 'en', values: { title: 't', body: 'b' } } })
  check('before 0086: order kinds send (old rule), others need a grant; the row is written the old way', l1.outcome === 'sent' && l2.reason === 'no_consent' && !('idempotency_key' in legacy.tables['wa_messages']![0]!))
  resetWaSendStateForTests()
}

async function live() {
  if (!BASE_URL) { record('live: grants surface inert (no BASE_URL)', 'skip', 'set BASE_URL'); return }
  const res = await fetch(`${BASE_URL}/api/v1/agent/grants`, { signal: AbortSignal.timeout(15_000) })
  await res.json().catch(() => null)
  if (res.status === 404) check('AGENT_ENABLED=false ⇒ opt-in surface 404s (inert)', true)
  else record('live: grants surface', 'skip', `flag appears ON (status ${res.status})`)
}

async function main() {
  const quiet = console.error
  console.error = () => undefined // the send path logs the 0086 fallback once; keep the rig output readable
  try {
    await driver()
    templates()
    await sendPath()
  } finally {
    console.error = quiet
  }
  await live()
  console.log(`\nverify-whatsapp ${BASE_URL ? `-> ${BASE_URL}` : '(offline)'}\n`)
  for (const r of rows) console.log(`  ${r.status === 'pass' ? '✓' : r.status === 'skip' ? '⏭' : '✗'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
  const skipped = rows.filter((r) => r.status === 'skip').length
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${rows.length} checks: ${rows.length - failed - skipped} pass, ${skipped} skipped, ${failed} FAIL\n`)
  process.exitCode = failed === 0 ? 0 : 1
}
main().catch((e) => { console.error(e); process.exitCode = 2 })
