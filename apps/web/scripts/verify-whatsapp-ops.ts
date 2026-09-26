/**
 * verify-whatsapp-ops.ts — ADR-030 §6 (WhatsApp ops console + privacy operations) against a running server on a
 * disposable Supabase stack (CI: money-rigs, :3000; migrations 0086 / 0087 applied by db:bootstrap).
 *
 *   A. authz      — every /api/v1/admin/whatsapp/* and /api/v1/admin/privacy/* route: 401 signed out, 403 for a
 *                   non-admin, 403 for a delegated agent token of an admin (hand-signed like verify-authz §10 when
 *                   AUTHZ_JWT_SECRET is set); the admin reads 200.
 *   B. console    — the delivery log lists a failed outbound row with its error code, never a body; the one-message
 *                   view writes `wa_message_read`; spend sums millipaise and formats ₹ on the server; consents list a
 *                   suppression by an opaque key, "Clear" deletes it and writes `wa_suppression_clear`; templates list
 *                   the code registry; sync without WABA → 409 not_configured; unrouted shows a masked phone and a
 *                   preview without the OTP, reply outside the window → 409, in the window → a send result + audit,
 *                   Open ticket for a number with no account → 409 no_account.
 *   C. retention  — the wa-retention cron (driven with CRON_SECRET): an old row is redacted (text, payload), an old row
 *                   on legal hold and an old row of a user with an open ticket are kept, old media is removed from the
 *                   bucket with the text kept, a never-bound quiet number is deleted, a number with a WhatsApp grant
 *                   is kept; the heartbeat is recorded.
 *   D. privacy    — record by email → queue (overdue flagged for a past due date) → in progress → illegal step 409 →
 *                   export download (audit `dpdp_export`) → done needs an answer → done; erasure done → messages
 *                   redacted, conversation unbound, WhatsApp grant revoked, the answer carries the fixed sentence;
 *                   unknown account → 404.
 *   E. transcript — (needs AGENT_BASE_URL: the support routes exist only with AGENT_ENABLED) a WhatsApp ticket's
 *                   transcript shows only messages since the bind time, a number now bound to someone else shows
 *                   nothing, and every read writes `wa_transcript_read` (entity support_ticket).
 *
 * Every row it creates is tagged and deleted at the end (audit rows of its own users included).
 *
 * Run: BASE_URL=http://localhost:3000 [AGENT_BASE_URL=http://localhost:3001] [CRON_SECRET=…] [AUTHZ_JWT_SECRET=…] \
 *      pnpm --filter @amclub/web exec tsx scripts/verify-whatsapp-ops.ts
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createHmac, randomUUID } from 'crypto'
import { createClient } from '@supabase/supabase-js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = (process.env['BASE_URL'] ?? 'http://localhost:3000').replace(/\/$/, '')
const AGENT_BASE = (process.env['AGENT_BASE_URL'] ?? '').replace(/\/$/, '')
const CRON_SECRET = process.env['CRON_SECRET'] ?? ''
const JWT_SECRET = process.env['AUTHZ_JWT_SECRET'] ?? ''
const BUCKET = process.env['WA_MEDIA_BUCKET'] || 'wa-media'
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })

let pass = 0, fail = 0, skipped = 0
const check = (n: string, ok: boolean, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${extra && !ok ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
const skip = (n: string, why: string) => { console.log(`  ⏭ ${n} — ${why}`); skipped++ }
const tag = `waops_${Date.now()}`
const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()
let seq = 0
const phone = () => `919${String((Date.now() + ++seq * 7919) % 1_000_000_000).padStart(9, '0')}`

const created = { users: [] as string[], convs: [] as string[], tickets: [] as string[], requests: [] as string[], grants: [] as string[], suppressions: [] as string[], objects: [] as string[] }

async function mkUser(label: string, roles: string[], phoneE164?: string): Promise<{ uid: string; token: string; email: string }> {
  const email = `${tag}_${label}@killtest.amclub`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(`${label}: ${error.message}`)
  created.users.push(data.user.id)
  const { error: uErr } = await admin.from('users').insert({ id: data.user.id, email, roles, ...(phoneE164 ? { phone: `+${phoneE164}` } : {}) })
  if (uErr) throw new Error(`${label} users: ${uErr.message}`)
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } })
  const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
  return { uid: data.user.id, token: s.session!.access_token, email }
}

/** A delegated agent token, signed like lib/agent/token.ts mints them (verify-authz §10). */
function delegated(sub: string, persona: string, scopes: string[]): string {
  const b64u = (v: string) => Buffer.from(v).toString('base64url')
  const iat = Math.floor(Date.now() / 1000)
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64u(JSON.stringify({ sub, role: 'authenticated', aud: 'authenticated', iat, exp: iat + 600, amc_persona: persona, amc_scopes: scopes }))
  return `${head}.${body}.${createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url')}`
}

async function call(base: string, token: string | null, p: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any; headers: Headers; text: string }> {
  const r = await fetch(`${base}${p}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const text = await r.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: r.status, json, headers: r.headers, text }
}
const api = (token: string | null, p: string, method = 'GET', body?: unknown) => call(BASE, token, p, method, body)

async function conv(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from('wa_conversations').insert(row).select('id').single()
  if (error) throw new Error(`wa_conversations: ${error.message}`)
  created.convs.push(data.id)
  return data.id as string
}
async function msg(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from('wa_messages').insert(row).select('id').single()
  if (error) throw new Error(`wa_messages: ${error.message}`)
  return data.id as string
}
async function audited(actor: string, action: string, entityId?: string): Promise<boolean> {
  let q = admin.from('audit_logs').select('id').eq('actor_id', actor).eq('action', action)
  if (entityId) q = q.eq('entity_id', entityId)
  const { data } = await q.limit(1)
  return (data ?? []).length > 0
}

async function main() {
  console.log(`\nWhatsApp ops + privacy (ADR-030 §6) → ${BASE}${AGENT_BASE ? ` · agent server ${AGENT_BASE}` : ''}\n`)
  const probe86 = await admin.from('wa_messages').select('id, redacted_at, legal_hold, cost_millipaise').limit(1)
  const probe87 = await admin.from('dpdp_requests').select('id').limit(1)
  if (probe86.error || probe87.error) {
    check('migrations 0086 and 0087 are applied on this stack (db:bootstrap)', false, (probe86.error ?? probe87.error)!.message)
    return
  }

  const ops = await mkUser('ops', ['msme', 'admin', 'ops'])
  const buyerPhone = phone()
  const buyer = await mkUser('buyer', ['msme'], buyerPhone)
  const stranger = await mkUser('stranger', ['msme'])

  // ── A. authz ─────────────────────────────────────────────────────────────
  console.log('A. admin routes refuse everyone but an admin / ops session:')
  const NIL = randomUUID()
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/api/v1/admin/whatsapp/overview'],
    ['GET', '/api/v1/admin/whatsapp/messages'],
    ['GET', `/api/v1/admin/whatsapp/messages/${NIL}`],
    ['GET', '/api/v1/admin/whatsapp/templates'],
    ['POST', '/api/v1/admin/whatsapp/templates/sync'],
    ['GET', '/api/v1/admin/whatsapp/spend'],
    ['GET', '/api/v1/admin/whatsapp/consents'],
    ['DELETE', `/api/v1/admin/whatsapp/suppressions/${'0'.repeat(32)}`],
    ['GET', '/api/v1/admin/whatsapp/unrouted'],
    ['POST', `/api/v1/admin/whatsapp/unrouted/${NIL}/reply`, { text: 'hi', clickId: randomUUID() }],
    ['POST', `/api/v1/admin/whatsapp/unrouted/${NIL}/ticket`],
    ['GET', '/api/v1/admin/privacy/requests'],
    ['POST', '/api/v1/admin/privacy/requests', { identifier: 'x@y.z', kind: 'access', source: 'email' }],
    ['PATCH', `/api/v1/admin/privacy/requests/${NIL}`, { action: 'in_progress' }],
    ['GET', `/api/v1/admin/privacy/requests/${NIL}/export`],
  ]
  const signedOut = await Promise.all(routes.map(([m, p, b]) => api(null, p, m, b)))
  check(`signed out → 401 on all ${routes.length} routes`, signedOut.every((r) => r.status === 401), signedOut.map((r, i) => `${routes[i]![1]}:${r.status}`).filter((s) => !s.endsWith(':401')).join(' '))
  const nonAdmin = await Promise.all(routes.map(([m, p, b]) => api(stranger.token, p, m, b)))
  check(`a signed-in non-admin → 403 on all ${routes.length} routes`, nonAdmin.every((r) => r.status === 403), nonAdmin.map((r, i) => `${routes[i]![1]}:${r.status}`).filter((s) => !s.endsWith(':403')).join(' '))
  if (JWT_SECRET) {
    const tok = delegated(ops.uid, 'ops', ['read_order_evidence', 'summarize_dispute'])
    const del = await Promise.all(routes.map(([m, p, b]) => api(tok, p, m, b)))
    check(`an admin's delegated agent token → 403 on all ${routes.length} routes (admin actions are never tools)`, del.every((r) => r.status === 403), del.map((r, i) => `${routes[i]![1]}:${r.status}`).filter((s) => !s.endsWith(':403')).join(' '))
  } else skip('delegated-token probes', 'AUTHZ_JWT_SECRET unset (CI sets it)')
  const ov = await api(ops.token, '/api/v1/admin/whatsapp/overview')
  check('the admin reads the overview: driver state as booleans, no secret values', ov.status === 200 && typeof ov.json?.driver?.tokenSet === 'boolean' && !/EAA|Bearer/.test(ov.text), `http=${ov.status}`)

  // ── B. console ───────────────────────────────────────────────────────────
  console.log('\nB. the console:')
  const pA = phone()
  const cA = await conv({ phone_e164: pA, user_id: buyer.uid, locale: 'en', bound_at: ago(400), created_at: ago(400), last_inbound_at: ago(1) })
  const failedId = await msg({ conversation_id: cA, direction: 'out', kind: 'template', notification_kind: `${tag}_kind`, template_name: 'amc_order_placed_en', template_language: 'en', category: 'utility', status: 'failed', error_code: 131026, error_title: 'Message undeliverable', body: 'SECRET-BODY-should-not-list', idempotency_key: `${tag}:f1`, created_at: ago(1) })
  await msg({ conversation_id: cA, direction: 'out', kind: 'template', notification_kind: `${tag}_kind`, status: 'delivered', pricing_category: 'utility', billable: true, cost_millipaise: 11_500, idempotency_key: `${tag}:c1`, created_at: ago(2) })
  await msg({ conversation_id: cA, direction: 'out', kind: 'template', notification_kind: `${tag}_kind`, status: 'read', pricing_category: 'utility', billable: true, cost_millipaise: 11_500, idempotency_key: `${tag}:c2`, created_at: ago(3) })
  const log = await api(ops.token, `/api/v1/admin/whatsapp/messages?status=failed&kind=${tag}_kind`)
  const row = (log.json?.rows ?? []).find((r: any) => r.id === failedId)
  check('delivery log: the failed row with its error code and a masked phone; no body in the list', log.status === 200 && row?.errorCode === 131026 && row?.phoneMasked === `••••••••${pA.slice(-4)}` && !log.text.includes('SECRET-BODY'), `http=${log.status} row=${JSON.stringify(row)}`)
  check('delivery log: counts by status and the top error codes', (log.json?.counts?.failed ?? 0) >= 1 && (log.json?.topErrors ?? []).some((e: any) => e.code === 131026))
  const one = await api(ops.token, `/api/v1/admin/whatsapp/messages/${failedId}`)
  check('one message: the body is shown and the read is audit-logged (wa_message_read)', one.status === 200 && one.json?.message?.body === 'SECRET-BODY-should-not-list' && (await audited(ops.uid, 'wa_message_read', failedId)), `http=${one.status}`)
  const spend = await api(ops.token, '/api/v1/admin/whatsapp/spend')
  const util = (spend.json?.report?.byCategory ?? []).find((c: any) => c.category === 'utility')
  check('spend: integer millipaise summed per category and formatted to ₹ on the server', spend.status === 200 && (util?.costMillipaise ?? 0) >= 23_000 && /^₹[\d,]+\.\d{2}$/.test(util?.cost ?? ''), JSON.stringify(util))

  const pS = phone()
  await admin.from('wa_suppressions').insert({ phone_e164: pS, reason: 'not_on_whatsapp', error_code: 131026 })
  created.suppressions.push(pS)
  const cons = await api(ops.token, '/api/v1/admin/whatsapp/consents')
  const sup = (cons.json?.suppressions ?? []).find((s: any) => s.phoneMasked === `••••••••${pS.slice(-4)}`)
  check('consents: the suppression is listed masked, addressed by an opaque key (never the number)', cons.status === 200 && !!sup && /^[0-9a-f]{32}$/.test(sup.key) && !cons.text.includes(pS), `http=${cons.status}`)
  const clr = sup ? await api(ops.token, `/api/v1/admin/whatsapp/suppressions/${sup.key}`, 'DELETE') : { status: 0 }
  const { data: supLeft } = await admin.from('wa_suppressions').select('phone_e164').eq('phone_e164', pS)
  check('Clear deletes the suppression and writes wa_suppression_clear', clr.status === 200 && (supLeft ?? []).length === 0 && (await audited(ops.uid, 'wa_suppression_clear')), `http=${clr.status}`)

  const tpl = await api(ops.token, '/api/v1/admin/whatsapp/templates')
  check('templates: the code registry is listed (in code, not approved until synced)', tpl.status === 200 && (tpl.json?.rows ?? []).some((r: any) => r.name === 'amc_order_placed_en' && r.kinds.length > 0), `http=${tpl.status}`)
  if (!process.env['WHATSAPP_WABA_ID']) {
    const sync = await api(ops.token, '/api/v1/admin/whatsapp/templates/sync', 'POST')
    check('Sync now without WHATSAPP_WABA_ID → 409 not_configured (nothing called)', sync.status === 409 && sync.json?.error === 'not_configured', `http=${sync.status}`)
  } else skip('sync not configured', 'WHATSAPP_WABA_ID is set on this runner')

  const pU = phone()
  const cU = await conv({ phone_e164: pU, locale: 'en', last_inbound_at: ago(0), window_open_until: new Date(Date.now() + 3 * 3_600_000).toISOString() })
  await msg({ conversation_id: cU, direction: 'in', kind: 'text', body: 'hello my OTP is 482913 please help', status: 'received', created_at: ago(0) })
  const pU2 = phone()
  const cU2 = await conv({ phone_e164: pU2, locale: 'en', last_inbound_at: ago(2), window_open_until: ago(1) })
  await msg({ conversation_id: cU2, direction: 'in', kind: 'text', body: 'anyone there?', status: 'received', created_at: ago(2) })
  const un = await api(ops.token, '/api/v1/admin/whatsapp/unrouted')
  const uRow = (un.json?.rows ?? []).find((r: any) => r.conversationId === cU)
  const u2Row = (un.json?.rows ?? []).find((r: any) => r.conversationId === cU2)
  check('unrouted: masked phone, a preview without the OTP, the window open; a closed window is flagged', un.status === 200 && uRow?.phoneMasked === `••••••••${pU.slice(-4)}` && uRow?.preview.includes('[removed]') && !uRow?.preview.includes('482913') && uRow?.windowOpen === true && u2Row?.windowOpen === false && uRow?.hasAccount === false, JSON.stringify(uRow))
  const out = await api(ops.token, `/api/v1/admin/whatsapp/unrouted/${cU2}/reply`, 'POST', { text: 'Hello from AMClub', clickId: randomUUID() })
  check('reply outside the 24-hour window → 409 outside_window (nothing sent)', out.status === 409 && out.json?.error === 'outside_window', `http=${out.status}`)
  const rep = await api(ops.token, `/api/v1/admin/whatsapp/unrouted/${cU}/reply`, 'POST', { text: 'Hello from AMClub support', clickId: randomUUID() })
  check('reply inside the window → a send result through sendWhatsApp + wa_ops_reply audit', rep.status === 200 && typeof rep.json?.outcome === 'string' && (await audited(ops.uid, 'wa_ops_reply', cU)), `http=${rep.status} ${JSON.stringify(rep.json)}`)
  const tk = await api(ops.token, `/api/v1/admin/whatsapp/unrouted/${cU}/ticket`, 'POST')
  check('Open ticket for a number no account holds → 409 no_account', tk.status === 409 && tk.json?.error === 'no_account', `http=${tk.status}`)

  // ── C. retention ─────────────────────────────────────────────────────────
  console.log('\nC. the wa-retention cron:')
  const held = await mkUser('held', ['msme'], phone())
  const pH = phone()
  const cH = await conv({ phone_e164: pH, user_id: held.uid, locale: 'en', bound_at: ago(400), created_at: ago(400) })
  const { data: hTicket } = await admin.from('support_tickets').insert({ user_id: held.uid, role: 'buyer', channel: 'whatsapp', conversation_id: cH, reason: 'asked_for_human', status: 'open' }).select('id').single()
  if (hTicket) created.tickets.push(hTicket.id)
  const oldId = await msg({ conversation_id: cA, direction: 'in', kind: 'text', body: 'my address is 12 MG Road', payload: { id: `wamid.${tag}.old`, from: pA, type: 'text', text: { body: 'my address is 12 MG Road' } }, status: 'received', created_at: ago(200) })
  const holdId = await msg({ conversation_id: cA, direction: 'in', kind: 'text', body: 'kept for the dispute', status: 'received', legal_hold: true, created_at: ago(200) })
  const heldUserMsg = await msg({ conversation_id: cH, direction: 'in', kind: 'text', body: 'ticket evidence', status: 'received', created_at: ago(200) })
  const recentId = await msg({ conversation_id: cA, direction: 'in', kind: 'text', body: 'recent text', status: 'received', created_at: ago(10) })
  const mediaPath = `${cA}/wamid.${tag}.ogg`
  const up = await admin.storage.from(BUCKET).upload(mediaPath, new Uint8Array([1, 2, 3]), { contentType: 'audio/ogg', upsert: true })
  if (!up.error) created.objects.push(mediaPath)
  const mediaId = await msg({ conversation_id: cA, direction: 'in', kind: 'audio', body: 'caption stays', media_ref: mediaPath, mime: 'audio/ogg', status: 'received', created_at: ago(100) })
  const pX = phone()
  const cX = await conv({ phone_e164: pX, locale: 'en', created_at: ago(60), last_inbound_at: ago(60) })
  await msg({ conversation_id: cX, direction: 'in', kind: 'text', body: 'who is this', status: 'received', created_at: ago(60) })
  const pK = phone()
  const cK = await conv({ phone_e164: pK, locale: 'en', created_at: ago(60), last_inbound_at: ago(60) })
  const { data: gK } = await admin.from('agent_grants').insert({ user_id: buyer.uid, persona: 'buyer', scopes: [], channel: 'whatsapp', channel_identity: `+${pK}`, consent: { rig: tag }, revoked_at: ago(50) }).select('id').single()
  if (gK) created.grants.push(gK.id)

  const cron = await fetch(`${BASE}/api/v1/cron/wa-retention`, { headers: CRON_SECRET ? { Authorization: `Bearer ${CRON_SECRET}` } : {} })
  const res = (await cron.json().catch(() => ({}))) as Record<string, any>
  check('the cron runs (200) and reports its counts', cron.status === 200 && res['notReady'] === false && typeof res['redacted'] === 'number', `http=${cron.status} ${JSON.stringify(res)}`)
  const get = async (id: string) => (await admin.from('wa_messages').select('body, payload, media_ref, redacted_at, legal_hold').eq('id', id).maybeSingle()).data as any
  const o = await get(oldId)
  check('an old row is redacted: no text, the payload reduced to ids / kind / time, redacted_at set', !!o && o.body === null && !!o.redacted_at && o.payload?.redacted === true && o.payload?.id === `wamid.${tag}.old` && !JSON.stringify(o.payload).includes('MG Road') && !JSON.stringify(o.payload).includes(pA), JSON.stringify(o))
  const h = await get(holdId)
  check('an old row on legal hold is kept', h?.body === 'kept for the dispute' && h?.redacted_at === null)
  const hu = await get(heldUserMsg)
  check('an old row of a user with an open support ticket is kept', hu?.body === 'ticket evidence' && hu?.redacted_at === null)
  const r = await get(recentId)
  check('a recent row is untouched', r?.body === 'recent text' && r?.redacted_at === null)
  const m = await get(mediaId)
  const { data: objs } = await admin.storage.from(BUCKET).list(cA)
  if (up.error) skip('media retention', `upload to ${BUCKET} failed: ${up.error.message}`)
  else check('media older than the media period: the object is deleted, the reference cleared, the text kept', m?.media_ref === null && m?.body === 'caption stays' && !(objs ?? []).some((x) => mediaPath.endsWith(x.name)), JSON.stringify(m))
  const { data: xLeft } = await admin.from('wa_conversations').select('id').eq('id', cX)
  const { data: kLeft } = await admin.from('wa_conversations').select('id').eq('id', cK)
  check('a quiet number that never had an account is deleted with its messages', (xLeft ?? []).length === 0)
  check('a quiet number a WhatsApp grant was given from is kept (it had an account)', (kLeft ?? []).length === 1)
  const { data: beat } = await admin.from('cron_heartbeats').select('status, last_result').eq('name', 'wa-retention').maybeSingle()
  check('the heartbeat is recorded', !!beat, JSON.stringify(beat))

  // ── D. privacy ───────────────────────────────────────────────────────────
  console.log('\nD. DPDP requests:')
  const rec = await api(ops.token, '/api/v1/admin/privacy/requests', 'POST', { identifier: buyer.email, kind: 'access', source: 'email', details: `${tag} please send my data` })
  const reqId = rec.json?.request?.id as string | undefined
  if (reqId) created.requests.push(reqId)
  check('record a request received by email → 201, due in dpdp_due_days, audit dpdp_request_create', rec.status === 201 && !!reqId && new Date(rec.json.request.due_at).getTime() > Date.now() + 25 * DAY && (await audited(ops.uid, 'dpdp_request_create', reqId)), `http=${rec.status}`)
  const none = await api(ops.token, '/api/v1/admin/privacy/requests', 'POST', { identifier: `${tag}-nobody@killtest.amclub`, kind: 'access', source: 'email' })
  check('an identifier no account matches → 404 no_account', none.status === 404 && none.json?.error === 'no_account', `http=${none.status}`)
  const { data: late } = await admin.from('dpdp_requests').insert({ user_id: buyer.uid, kind: 'grievance', source: 'web', details: tag, due_at: ago(1), created_at: ago(31) }).select('id').single()
  if (late) created.requests.push(late.id)
  const q = await api(ops.token, '/api/v1/admin/privacy/requests')
  const qRows = q.json?.requests ?? []
  const lateRow = qRows.find((x: any) => x.id === late?.id)
  check('the queue: open first, the past-due request flagged overdue, phones masked', q.status === 200 && lateRow?.overdue === true && qRows.findIndex((x: any) => x.id === late?.id) < qRows.findIndex((x: any) => x.id === reqId) && !q.text.includes(buyerPhone) && lateRow?.user?.phoneMasked === `••••••••${buyerPhone.slice(-4)}` && typeof q.json?.retention?.textDays === 'number', `http=${q.status}`)
  const ip = await api(ops.token, `/api/v1/admin/privacy/requests/${reqId}`, 'PATCH', { action: 'in_progress' })
  const ip2 = await api(ops.token, `/api/v1/admin/privacy/requests/${reqId}`, 'PATCH', { action: 'in_progress' })
  check('open → in progress (200); again → 409 illegal_transition', ip.status === 200 && ip.json?.request?.status === 'in_progress' && ip2.status === 409 && ip2.json?.error === 'illegal_transition', `${ip.status}/${ip2.status}`)
  const ex = await api(ops.token, `/api/v1/admin/privacy/requests/${reqId}/export`)
  check('access export: a JSON download of the account (consents, WhatsApp, notifications) + audit dpdp_export', ex.status === 200 && /attachment/.test(ex.headers.get('content-disposition') ?? '') && ex.json?.format === 'amclub-dpdp-access-v1' && ex.json?.user_id === buyer.uid && Array.isArray(ex.json?.whatsapp?.messages) && (await audited(ops.uid, 'dpdp_export', reqId)), `http=${ex.status}`)
  const short = await api(ops.token, `/api/v1/admin/privacy/requests/${reqId}`, 'PATCH', { action: 'done', resolution: 'ok' })
  check('done without an answer the user can read → 422', short.status === 422, `http=${short.status}`)
  const done = await api(ops.token, `/api/v1/admin/privacy/requests/${reqId}`, 'PATCH', { action: 'done', resolution: 'We have emailed you a copy of your data.' })
  const again = await api(ops.token, `/api/v1/admin/privacy/requests/${reqId}`, 'PATCH', { action: 'rejected', resolution: 'Changed my mind about this one.' })
  check('done → resolved_at set, audit dpdp_request_done; a final request never moves again (409)', done.status === 200 && !!done.json?.request?.resolved_at && (await audited(ops.uid, 'dpdp_request_done', reqId)) && again.status === 409, `${done.status}/${again.status}`)

  const eraser = await mkUser('eraser', ['msme'], phone())
  const pE = phone()
  const cE = await conv({ phone_e164: pE, user_id: eraser.uid, locale: 'en', bound_at: ago(20), created_at: ago(20) })
  const e1 = await msg({ conversation_id: cE, direction: 'in', kind: 'text', body: 'please delete this', status: 'received', created_at: ago(5) })
  const e2 = await msg({ conversation_id: cE, direction: 'out', kind: 'text', body: 'Sure', status: 'delivered', created_at: ago(5) })
  const { data: gE } = await admin.from('agent_grants').insert({ user_id: eraser.uid, persona: 'buyer', scopes: ['support_lookup'], channel: 'whatsapp', channel_identity: `+${pE}`, consent: { rig: tag } }).select('id').single()
  if (gE) created.grants.push(gE.id)
  const { data: er } = await admin.from('dpdp_requests').insert({ user_id: eraser.uid, kind: 'erasure', source: 'whatsapp', due_at: new Date(Date.now() + 30 * DAY).toISOString() }).select('id').single()
  if (er) created.requests.push(er.id)
  const ed = await api(ops.token, `/api/v1/admin/privacy/requests/${er?.id}`, 'PATCH', { action: 'done', resolution: 'Your erasure request is complete.' })
  const [x1, x2] = [await get(e1), await get(e2)]
  const { data: cEAfter } = await admin.from('wa_conversations').select('user_id, bound_at').eq('id', cE).maybeSingle()
  const { data: gAfter } = await admin.from('agent_grants').select('revoked_at').eq('id', gE?.id ?? NIL).maybeSingle()
  check('erasure done: every message redacted, the conversation unbound, the WhatsApp grant revoked', ed.status === 200 && x1?.body === null && !!x1?.redacted_at && x2?.body === null && cEAfter?.user_id === null && cEAfter?.bound_at === null && !!gAfter?.revoked_at, `http=${ed.status} ${JSON.stringify(ed.json)}`)
  check('the erasure answer carries the fixed sentence (business records kept by law)', /orders, invoices and payment records/.test(ed.json?.request?.resolution ?? ''), ed.json?.request?.resolution)
  const { data: users } = await admin.from('users').select('id').eq('id', eraser.uid)
  check('the users row is not deleted by an erasure', (users ?? []).length === 1)

  // ── E. transcript scope + audit (agent server) ───────────────────────────
  console.log('\nE. support ticket transcripts:')
  if (!AGENT_BASE) {
    skip('transcript scope and the wa_transcript_read audit row', 'AGENT_BASE_URL unset (the support routes exist only with AGENT_ENABLED)')
  } else {
    const holder = await mkUser('holder', ['msme'], phone())
    const pT = phone()
    const cT = await conv({ phone_e164: pT, user_id: holder.uid, locale: 'en', created_at: ago(30), bound_at: ago(1) })
    await msg({ conversation_id: cT, direction: 'in', kind: 'text', body: `${tag} previous holder wrote this`, status: 'received', created_at: ago(5) })
    await msg({ conversation_id: cT, direction: 'in', kind: 'text', body: `${tag} the holder needs help`, status: 'received', created_at: new Date(Date.now() - 3_600_000).toISOString() })
    const { data: t1 } = await admin.from('support_tickets').insert({ user_id: holder.uid, role: 'buyer', channel: 'whatsapp', conversation_id: cT, reason: 'asked_for_human', status: 'open' }).select('id').single()
    if (t1) created.tickets.push(t1.id)
    const tr = await call(AGENT_BASE, ops.token, `/api/v1/agent/admin/support/tickets/${t1?.id}`)
    const bodies = ((tr.json?.transcript ?? []) as any[]).map((l) => l.body).join(' | ')
    check('the transcript shows only messages since the number was bound to this user', tr.status === 200 && bodies.includes('the holder needs help') && !bodies.includes('previous holder'), `http=${tr.status} ${bodies}`)
    const { data: aud } = await admin.from('audit_logs').select('entity, after').eq('actor_id', ops.uid).eq('action', 'wa_transcript_read').eq('entity_id', t1?.id ?? NIL).limit(1).maybeSingle()
    check('every transcript read writes wa_transcript_read (entity support_ticket)', aud?.entity === 'support_ticket' && (aud?.after as any)?.messages === 1, JSON.stringify(aud))
    const other = await mkUser('other', ['msme'])
    const { data: t2 } = await admin.from('support_tickets').insert({ user_id: other.uid, role: 'buyer', channel: 'whatsapp', conversation_id: cT, reason: 'asked_for_human', status: 'open' }).select('id').single()
    if (t2) created.tickets.push(t2.id)
    const tr2 = await call(AGENT_BASE, ops.token, `/api/v1/agent/admin/support/tickets/${t2?.id}`)
    check('a ticket whose number now belongs to someone else shows no transcript', tr2.status === 200 && (tr2.json?.transcript ?? []).length === 0 && tr2.json?.transcriptScope === 'not_holder', `http=${tr2.status} scope=${tr2.json?.transcriptScope}`)
  }
}

async function cleanup() {
  const t = async (p: PromiseLike<{ error: { message: string } | null }>) => { const { error } = await p; if (error) console.warn('  cleanup:', error.message) }
  if (created.objects.length) await admin.storage.from(BUCKET).remove(created.objects).catch(() => null)
  for (const id of created.tickets) await t(admin.from('support_tickets').delete().eq('id', id))
  for (const id of created.convs) {
    await t(admin.from('support_tickets').delete().eq('conversation_id', id))
    await t(admin.from('wa_conversations').delete().eq('id', id))
  }
  for (const id of created.requests) await t(admin.from('dpdp_requests').delete().eq('id', id))
  for (const id of created.grants) await t(admin.from('agent_grants').delete().eq('id', id))
  for (const p of created.suppressions) await t(admin.from('wa_suppressions').delete().eq('phone_e164', p))
  await t(admin.from('dpdp_requests').delete().in('user_id', created.users))
  for (const uid of created.users) {
    await t(admin.from('audit_logs').delete().eq('actor_id', uid))
    await t(admin.from('agent_grants').delete().eq('user_id', uid))
    await t(admin.from('notifications').delete().eq('user_id', uid))
    await t(admin.from('users').delete().eq('id', uid))
    await admin.auth.admin.deleteUser(uid).catch(() => {})
  }
}

main()
  .catch((e) => { console.error(e); fail++ })
  .finally(async () => {
    await cleanup().catch((e) => console.warn('cleanup failed', e))
    console.log(`\n${fail === 0 ? '✅ WHATSAPP OPS — ALL CRITERIA PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed, ${skipped} skipped\n`)
    process.exit(fail === 0 ? 0 : 1)
  })
