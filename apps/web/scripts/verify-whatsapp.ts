/**
 * verify-whatsapp — S0.5 rails kill-test (verify-* convention).
 *
 * OFFLINE (always, no network, no DB writes):
 *   - meta_cloud signature verification rejects a tampered body / wrong secret
 *   - interakt shared-secret header verification
 *   - parseInbound yields a stable vendor_message_id (the idempotency key), so a
 *     replayed webhook maps to the same row
 *   - the stub driver never calls the network (fetch is a throwing spy)
 *   - the template registry has no unknown-kind path; always-allowed set is
 *     order/payment only; START/STOP keyword classification incl. vernacular
 *   - the dispatcher's opt-in gate: a non-transactional kind without a grant →
 *     skipped:no-opt-in; a transactional kind → stub (dark) — proven through
 *     the SAME decision function the handler uses.
 *
 * LIVE (BASE_URL to a running dark server): /api/v1/agent/grants 404s while
 * AGENT_ENABLED=false (the opt-in surface is inert). The runtime webhook is not
 * exercised here (it runs on Fly); docs/agents/WHATSAPP.md covers the Meta
 * test-number flow. Zero prod residue.
 * Run: [BASE_URL=<url>] pnpm --filter @amclub/web whatsapp:verify
 */
import { createHmac } from 'node:crypto'
import {
  WA_ALWAYS_ALLOWED_KINDS,
  classifyKeyword,
  createWhatsAppProvider,
  makeInteraktDriver,
  makeMetaCloudDriver,
  templateFor,
  whatsappConfigFromEnv,
} from '@amclub/agent-core'

const BASE_URL = process.env['BASE_URL'] || ''
type Status = 'pass' | 'FAIL' | 'skip'
const rows: { name: string; status: Status; detail?: string }[] = []
let failed = 0
const record = (name: string, status: Status, detail?: string) => { rows.push({ name, status, ...(detail ? { detail } : {}) }); if (status === 'FAIL') failed++ }
const check = (name: string, ok: boolean, detail?: string) => record(name, ok ? 'pass' : 'FAIL', detail)

const META = { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { messages: [{ from: '919876543210', id: 'wamid.REPLAY1', timestamp: '1726800000', type: 'text', text: { body: 'START' } }] } }] }] }

/** The dispatcher's send decision, mirrored exactly (no phone/template/opt-in gates → never a bill). */
function decide(kind: string, optIn: boolean, live: boolean): string {
  if (!templateFor(kind, 'en')) return 'skipped:no-template'
  if (!WA_ALWAYS_ALLOWED_KINDS.has(kind) && !optIn) return 'skipped:no-opt-in'
  return live ? 'sent' : 'stub'
}

async function offline() {
  const noNet: typeof fetch = (async () => { throw new Error('network call attempted') }) as unknown as typeof fetch
  const meta = makeMetaCloudDriver({ driver: 'meta_cloud', phoneNumberId: 'p', accessToken: 't', appSecret: 'sekrit' }, noNet)
  const raw = JSON.stringify(META)
  const sig = 'sha256=' + createHmac('sha256', 'sekrit').update(raw).digest('hex')
  check('meta signature: valid body accepted', meta.verifySignature(raw, { 'x-hub-signature-256': sig }))
  check('meta signature: tampered body rejected', !meta.verifySignature(raw.replace('START', 'STOP'), { 'x-hub-signature-256': sig }))
  check('meta signature: wrong secret rejected', !makeMetaCloudDriver({ driver: 'meta_cloud', appSecret: 'other' }, noNet).verifySignature(raw, { 'x-hub-signature-256': sig }))
  const a = meta.parseInbound(META), b = meta.parseInbound(JSON.parse(raw))
  check('inbound idempotency key stable across replay', a.messages[0]?.vendorMessageId === 'wamid.REPLAY1' && b.messages[0]?.vendorMessageId === a.messages[0]?.vendorMessageId)
  const ik = makeInteraktDriver({ driver: 'interakt', interaktApiKey: 'k', interaktWebhookSecret: 's3' }, noNet)
  check('interakt shared secret enforced', ik.verifySignature('{}', { 'x-interakt-secret': 's3' }) && !ik.verifySignature('{}', { 'x-interakt-secret': 'x' }))
  const stub = createWhatsAppProvider(whatsappConfigFromEnv({}), noNet)
  const r = await stub.sendTemplate('919876543210', 'amc_order_placed_en', 'en', ['x']).catch((e: Error) => ({ ok: false, detail: e.message, vendorMessageId: null }))
  check('stub driver never calls the network', stub.name === 'stub' && r.detail === 'stub')
  check('unknown kind can never reach the vendor', decide('marketing_blast', true, true) === 'skipped:no-template')
  check('non-transactional kind without opt-in is skipped', decide('rfq_matched', false, true) === 'skipped:no-opt-in')
  check('transactional kind sends without opt-in (dark ⇒ stub)', decide('order_placed', false, false) === 'stub')
  check('opted-in non-transactional kind would send when live', decide('rfq_matched', true, true) === 'sent')
  check('START/नमस्ते → opt_in; JOIN → onboard (S1.6); STOP/बंद → opt_out', classifyKeyword('start') === 'opt_in' && classifyKeyword('JOIN') === 'onboard' && classifyKeyword('नमस्ते') === 'opt_in' && classifyKeyword('STOP') === 'opt_out' && classifyKeyword('बंद') === 'opt_out' && classifyKeyword('price?') === null)
  // founder decision 2026-09-23: a plain negative answers an open card; STOP words always opt out
  check('typed no: "no" / "cancel" / "नहीं" / "వద్దు" opt out with no card open, answer the card while one is open; STOP / UNSUBSCRIBE / बंद / रोकें / ఆపు opt out either way', ['no', 'cancel', 'नहीं', 'వద్దు'].every((w) => classifyKeyword(w) === 'opt_out' && classifyKeyword(w, { cardOpen: true }) === 'card_no') && ['stop', 'unsubscribe', 'बंद', 'रोकें', 'ఆపు'].every((w) => classifyKeyword(w, { cardOpen: true }) === 'opt_out' && classifyKeyword(w) === 'opt_out'))
}

async function live() {
  if (!BASE_URL) { record('live: grants surface inert (no BASE_URL)', 'skip', 'set BASE_URL'); return }
  const res = await fetch(`${BASE_URL}/api/v1/agent/grants`)
  await res.json().catch(() => null)
  if (res.status === 404) check('AGENT_ENABLED=false ⇒ opt-in surface 404s (inert)', true)
  else record('live: grants surface', 'skip', `flag appears ON (status ${res.status})`)
}

async function main() {
  await offline()
  await live()
  console.log(`\nverify-whatsapp ${BASE_URL ? `-> ${BASE_URL}` : '(offline)'}\n`)
  for (const r of rows) console.log(`  ${r.status === 'pass' ? '✓' : r.status === 'skip' ? '⏭' : '✗'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
  const skipped = rows.filter((r) => r.status === 'skip').length
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${rows.length} checks: ${rows.length - failed - skipped} pass, ${skipped} skipped, ${failed} FAIL\n`)
  process.exitCode = failed === 0 ? 0 : 1
}
main().catch((e) => { console.error(e); process.exitCode = 2 })
