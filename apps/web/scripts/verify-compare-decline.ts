/**
 * verify-compare-decline — S1.2 comparability flags, buyer decline, pointers
 * (verify-* convention; rig, service role; modelled on verify-quote-extraction).
 *
 * Needs BASE_URL + NEXT_PUBLIC_SUPABASE_URL/ANON_KEY + SUPABASE_SERVICE_ROLE_KEY.
 * Kill-test users, RFQs (via the API so fan-out matches the providers), quotes
 * and one simulated order are created and removed in finally; agent_settings
 * touched are restored. Zero residue.
 *
 *   OFFLINE: the runtime banned-phrase gate (sanitizePointers) drops "choose Quote A".
 *   Deterministic: a 3-quote fixture through GET /compare returns exact paise totals
 *     and flags; a single quote → only_quote.
 *   Decline authz: another buyer → 403; provider session → 403; chose_other → 422;
 *     declined twice → 409; RFQ accepted → 409.
 *   Decline (server flag OFF): status/reason/declined_by, quote_events.declined (no
 *     note text), template message in the provider's locale, quote_declined
 *     notification, no ai_* rows, decline_decision_id null.
 *   Decline (server flag ON, stub): one ai_invocations (decline_message, run_id null),
 *     one ai_decisions (feature decline_message, tool decline_quote), decision id set.
 *   Auto-decline on accept (simulated checkout): loser carries another_quote_accepted /
 *     system; no model rows.
 *   Pointers: flag OFF → null; ON (stub) → one entry per quote, rfqs.compare_pointers
 *     written, second call is a cache hit (no second ai_invocations row).
 *   Render: buyer /app/rfq/[id] and provider /partner/rfqs/[id] (cookie sessions) show the
 *     table / declined block against this DB.
 *   Provider RLS read (anon key + provider token): decline_note not readable,
 *     decline_message readable.
 *
 * Run: BASE_URL=<url> pnpm --filter @amclub/web agents:verify:compare
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { declineMessageTemplate, sanitizePointers } from '@amclub/shared'

const BASE = (process.env['BASE_URL'] || '').replace(/\/$/, '')
const SUPA_URL = process.env['NEXT_PUBLIC_SUPABASE_URL'] || ''
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] || ''
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY'] || ''
const SCOPE = 'GST filing for FY 2025-26 including annual return, kill-test scope text.'

type Status = 'pass' | 'FAIL' | 'skip'
const rows: { name: string; status: Status; detail?: string }[] = []
let failed = 0
function record(name: string, status: Status, detail?: string) {
  rows.push({ name, status, ...(detail ? { detail } : {}) })
  if (status === 'FAIL') failed++
}
const check = (name: string, cond: boolean, detail?: string) => record(name, cond ? 'pass' : 'FAIL', detail)
const skip = (name: string, why: string) => record(name, 'skip', why)
const json = (r: Response) => r.json().catch(() => ({})) as Promise<Record<string, unknown>>

function offline() {
  const { pointers, dropped } = sanitizePointers(
    { pointers: [{ quote_id: '00000000-0000-0000-0000-000000000001', lines: ['Choose Quote A, it is the best'] }, { quote_id: '00000000-0000-0000-0000-000000000002', lines: ['GST is not included; the total after GST is ₹10,620'] }] },
    'en',
  )
  check('runtime banned-phrase gate drops "choose Quote A" and keeps the clean line', dropped.length === 1 && pointers.pointers[0]!.lines.length === 0 && pointers.pointers[1]!.lines.length === 1)
}

async function main() {
  offline()
  if (!BASE || !SUPA_URL || !ANON || !SERVICE) {
    skip('rig checks', 'set BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
    return
  }
  const admin: SupabaseClient = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } })
  const tag = `kt_cmp_${Date.now().toString(36)}`
  const created = { users: [] as string[], msmeIds: [] as string[], providerIds: [] as string[], rfqIds: [] as string[] }
  const settingsBefore = new Map<string, { existed: boolean; value: unknown }>()
  async function remember(key: string) {
    const { data } = await admin.from('agent_settings').select('value').eq('key', key).maybeSingle()
    settingsBefore.set(key, { existed: !!data, value: data?.value ?? null })
  }
  async function setSetting(key: string, value: unknown) {
    await admin.from('agent_settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  }
  async function mkUser(label: string, roles: string[]) {
    const email = `${tag}_${label}@killtest.amclub`
    const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
    if (error) throw new Error(`${label}: ${error.message}`)
    created.users.push(data.user.id)
    await admin.from('users').insert({ id: data.user.id, email, roles })
    const anon = createClient(SUPA_URL, ANON, { auth: { persistSession: false } })
    const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
    return { uid: data.user.id, token: s.session!.access_token }
  }
  const api = (token: string, p: string, body?: unknown, method = 'POST') =>
    fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })

  console.log(`\nverify-compare-decline → ${BASE}\n`)
  try {
    const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
    const categoryId = cat!.id
    const probe = await fetch(`${BASE}/api/v1/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    await json(probe)
    const flagOn = probe.status !== 404

    const buyer = await mkUser('buyer', ['msme'])
    const buyer2 = await mkUser('buyer2', ['msme'])
    for (const b of [buyer, buyer2]) {
      const { data: m } = await admin.from('msme_profiles').insert({ user_id: b.uid, business_name: `CMP Buyer ${b.uid.slice(0, 4)}`, state: 'KA', sector: 'services' }).select('id').single()
      created.msmeIds.push(m!.id)
    }
    async function mkProvider(label: string, languages: string[]) {
      const u = await mkUser(label, ['provider'])
      const { data: p } = await admin.from('provider_profiles').insert({ user_id: u.uid, legal_name: `${label} Pvt`, display_name: label, slug: `${tag}-${label}`, state: 'KA', city: 'X', languages, status: 'active', gstin: `29AAAAA0000A1Z${label.length}` }).select('id').single()
      created.providerIds.push(p!.id)
      await admin.from('provider_categories').insert({ provider_id: p!.id, category_id: categoryId })
      return { ...u, providerId: p!.id }
    }
    const p1 = await mkProvider('p1', ['en'])
    const p2 = await mkProvider('p2', ['hi', 'en'])
    const p3 = await mkProvider('p3', ['ta'])

    async function mkRfq(title: string): Promise<string> {
      const r = await api(buyer.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title, details: { need: 'gst filing' } })
      const d = await json(r)
      if (r.status !== 200 || !d['rfqId']) throw new Error(`rfq create ${r.status} ${JSON.stringify(d).slice(0, 120)}`)
      created.rfqIds.push(d['rfqId'] as string)
      return d['rfqId'] as string
    }
    async function quote(token: string, rfqId: string, body: Record<string, unknown>): Promise<string> {
      const r = await api(token, `/api/v1/rfq/${rfqId}/quote`, { scope: SCOPE, ...body })
      const d = await json(r)
      if (r.status !== 200) throw new Error(`quote ${r.status} ${JSON.stringify(d).slice(0, 120)}`)
      return d['quoteId'] as string
    }

    // ── Deterministic compare: the 3-quote fixture ────────────────────────
    const rfq1 = await mkRfq(`${tag} one`)
    const q1 = await quote(p1.token, rfq1, { price_paise: 1_000_000, delivery_days: 10, gst_included: true, transport_included: true, advance_percent: 0 })
    const q2 = await quote(p2.token, rfq1, { price_paise: 900_000, delivery_days: 12, gst_included: false })
    const q3 = await quote(p3.token, rfq1, { price_paise: 1_150_000, delivery_days: 5, gst_included: true, transport_included: false, advance_percent: 60 })
    let cmp = await api(buyer.token, `/api/v1/rfq/${rfq1}/compare?locale=en`, undefined, 'GET')
    let cmpBody = await json(cmp)
    const results = (cmpBody['results'] ?? []) as Array<{ id: string; normalizedTotalPaise: number; flags: string[] }>
    const byId = (id: string) => results.find((r) => r.id === id)
    check('GET /compare → 200 with one result per quote', cmp.status === 200 && results.length === 3, `status ${cmp.status} n=${results.length}`)
    check('normalised totals exact: ₹10,000 / ₹10,620 (GST added) / ₹11,500', byId(q1)?.normalizedTotalPaise === 1_000_000 && byId(q2)?.normalizedTotalPaise === 1_062_000 && byId(q3)?.normalizedTotalPaise === 1_150_000, JSON.stringify(results.map((r) => r.normalizedTotalPaise)))
    check('flags: q1 cheapest_after_normalization only', JSON.stringify(byId(q1)?.flags) === JSON.stringify(['cheapest_after_normalization']), JSON.stringify(byId(q1)?.flags))
    check('flags: q2 gst_not_included + transport_unstated + advance_unstated', ['gst_not_included', 'transport_unstated', 'advance_unstated'].every((f) => byId(q2)?.flags.includes(f)) && !byId(q2)?.flags.includes('cheapest_after_normalization'), JSON.stringify(byId(q2)?.flags))
    check('flags: q3 transport_not_included + advance_high + fastest', ['transport_not_included', 'advance_high', 'fastest'].every((f) => byId(q3)?.flags.includes(f)), JSON.stringify(byId(q3)?.flags))
    const other = await api(buyer2.token, `/api/v1/rfq/${rfq1}/compare`, undefined, 'GET')
    await json(other)
    check("another buyer's compare → 404", other.status === 404, `status ${other.status}`)
    if (!flagOn) check('pointers null while AGENT_ENABLED=false', cmpBody['pointers'] === null && cmpBody['pointers_source'] === 'off', `source ${cmpBody['pointers_source']}`)

    const rfqSingle = await mkRfq(`${tag} single`)
    await quote(p1.token, rfqSingle, { price_paise: 500_000, delivery_days: 3 })
    const single = await api(buyer.token, `/api/v1/rfq/${rfqSingle}/compare`, undefined, 'GET')
    const singleBody = await json(single)
    const sres = (singleBody['results'] ?? []) as Array<{ flags: string[] }>
    check('single quote → only_quote, no cheapest/fastest', sres.length === 1 && sres[0]!.flags.includes('only_quote') && !sres[0]!.flags.includes('fastest'), JSON.stringify(sres[0]?.flags))

    // ── Decline authz ─────────────────────────────────────────────────────
    let r = await api(buyer2.token, `/api/v1/rfq/${rfq1}/quote/${q3}/decline`, { reason: 'price_high' }); await json(r)
    check('another buyer declining → 403', r.status === 403, `status ${r.status}`)
    r = await api(p1.token, `/api/v1/rfq/${rfq1}/quote/${q3}/decline`, { reason: 'price_high' }); await json(r)
    check('provider session declining → 403 not_a_buyer', r.status === 403, `status ${r.status}`)
    r = await api(buyer.token, `/api/v1/rfq/${rfq1}/quote/${q3}/decline`, { reason: 'chose_other' }); let d = await json(r)
    check('chose_other from a client → 422 reason_reserved', r.status === 422 && d['error'] === 'reason_reserved', `status ${r.status}`)
    r = await api(buyer.token, `/api/v1/rfq/${rfq1}/quote/${q3}/decline`, { reason: 'bogus' }); await json(r)
    check('unknown reason → 422', r.status === 422, `status ${r.status}`)

    // ── Decline q3 (provider p3 speaks Tamil) — template or agent per the server flag ──
    if (flagOn) {
      for (const k of ['agents_enabled', 'cohort_user_ids']) await remember(k)
      const enabledBefore = (settingsBefore.get('agents_enabled')?.value ?? {}) as Record<string, boolean>
      await setSetting('agents_enabled', { ...enabledBefore, decline_message: false, compare_pointers: false })
    }
    const NOTE = 'Way above our budget; call me on 9876543210'
    r = await api(buyer.token, `/api/v1/rfq/${rfq1}/quote/${q3}/decline`, { reason: 'price_high', note: NOTE }); d = await json(r)
    check('buyer declines q3 → 200 { status: declined }', r.status === 200 && d['status'] === 'declined', `status ${r.status} ${JSON.stringify(d).slice(0, 120)}`)
    check('agent off → message_source template', d['message_source'] === 'template', String(d['message_source']))
    const { data: q3row } = await admin.from('quotes').select('status, decline_reason, decline_note, decline_message, decline_message_locale, declined_by, declined_at, decline_decision_id').eq('id', q3).maybeSingle()
    check('quotes row: declined / price_high / buyer / declined_at / note stored', q3row?.status === 'declined' && q3row?.decline_reason === 'price_high' && q3row?.declined_by === 'buyer' && !!q3row?.declined_at && (q3row?.decline_note ?? '').includes('budget'))
    check("template message in the provider's locale (ta) and no decision id", q3row?.decline_message_locale === 'ta' && q3row?.decline_message === declineMessageTemplate('price_high', 'ta').message && q3row?.decline_decision_id === null, `${q3row?.decline_message_locale} ${q3row?.decline_decision_id}`)
    const { data: ev } = await admin.from('quote_events').select('reason, payload, actor').eq('quote_id', q3).eq('event_type', 'declined').maybeSingle()
    check('quote_events.declined: reason + note_len, never the note text', ev?.reason === 'price_high' && (ev?.payload as Record<string, unknown>)?.['note_len'] === NOTE.length && !JSON.stringify(ev?.payload).includes('9876543210'), JSON.stringify(ev?.payload))
    const { count: notifCount } = await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', p3.uid).eq('kind', 'quote_declined')
    check('quote_declined notification row for the provider', (notifCount ?? 0) === 1, `count ${notifCount}`)
    const { count: invOff } = await admin.from('ai_invocations').select('id', { count: 'exact', head: true }).eq('user_id', buyer.uid).eq('feature', 'decline_message')
    const { count: decOff } = await admin.from('ai_decisions').select('id', { count: 'exact', head: true }).eq('decided_by', buyer.uid).eq('feature', 'decline_message')
    check('no ai_invocations / ai_decisions rows for a template decline', (invOff ?? 0) === 0 && (decOff ?? 0) === 0, `inv ${invOff} dec ${decOff}`)
    r = await api(buyer.token, `/api/v1/rfq/${rfq1}/quote/${q3}/decline`, { reason: 'other' }); d = await json(r)
    check('declining twice → 409 quote_not_declinable', r.status === 409 && d['error'] === 'quote_not_declinable', `status ${r.status}`)

    // ── Provider RLS read: decline_note hidden, decline_message readable ──
    const p3Client = createClient(SUPA_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${p3.token}` } } })
    const noteRead = await p3Client.from('quotes').select('decline_note').eq('id', q3).maybeSingle()
    check('provider (RLS, anon key) cannot read decline_note (permission denied)', !!noteRead.error && /permission denied|42501/i.test(`${noteRead.error.code} ${noteRead.error.message}`), `${noteRead.error?.code ?? 'no error'} ${noteRead.error?.message ?? JSON.stringify(noteRead.data)}`)
    const msgRead = await p3Client.from('quotes').select('id, status, decline_reason, decline_message').eq('id', q3).maybeSingle()
    check('provider (RLS) CAN read decline_message + reason on their own quote', !msgRead.error && msgRead.data?.status === 'declined' && !!msgRead.data?.decline_message, msgRead.error?.message)
    const starRead = await p3Client.from('quotes').select('*').eq('id', q3).maybeSingle()
    record('provider select(*) on quotes', 'pass', starRead.error ? `errors (${starRead.error.code}) — column privileges bite; no client does this` : `ok, decline_note ${Object.prototype.hasOwnProperty.call(starRead.data ?? {}, 'decline_note') ? 'PRESENT (unexpected)' : 'absent'}`)
    if (!starRead.error && Object.prototype.hasOwnProperty.call(starRead.data ?? {}, 'decline_note')) check('select(*) must not expose decline_note', false)

    // ── Render: buyer + provider RFQ pages (cookie sessions) against this DB ──
    // Only VISIBLE markup counts — next-intl inlines the full message bundle in a <script>.
    const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '')
    const cookieFor = async (email: string) => {
      const jar: Record<string, string> = {}
      const ssr = createServerClient(SUPA_URL, ANON, { cookies: { getAll() { return Object.entries(jar).map(([name, value]) => ({ name, value })) }, setAll(list) { for (const { name, value } of list) jar[name] = value } } })
      await ssr.auth.signInWithPassword({ email, password: 'Test1234!' })
      return Object.entries(jar).map(([n, v]) => `${n}=${v}`).join('; ')
    }
    const bp = await fetch(`${BASE}/app/rfq/${rfq1}`, { headers: { cookie: await cookieFor(`${tag}_buyer@killtest.amclub`) } })
    const bHtml = visible(await bp.text())
    check('buyer RFQ page renders: compare table with ₹10,620 normalised total + "Declined — price" on q3', bp.status === 200 && bHtml.includes('Compare quotes') && bHtml.includes('10,620') && bHtml.includes('Declined — price'), `status ${bp.status} table=${bHtml.includes('Compare quotes')} total=${bHtml.includes('10,620')} declined=${bHtml.includes('Declined — price')}`)
    const pp = await fetch(`${BASE}/partner/rfqs/${rfq1}`, { headers: { cookie: await cookieFor(`${tag}_p3@killtest.amclub`) } })
    const pHtml = visible(await pp.text())
    const taHead = declineMessageTemplate('price_high', 'ta').message.slice(0, 24)
    check('provider RFQ page renders: declined block + Tamil message, never the buyer note', pp.status === 200 && pHtml.includes('This quote was declined') && pHtml.includes(taHead) && !pHtml.includes('9876543210') && !pHtml.includes('budget'), `status ${pp.status} block=${pHtml.includes('This quote was declined')} msg=${pHtml.includes(taHead)}`)

    // ── Flag ON: decline q2 with the agent on (stub) ──────────────────────
    if (flagOn) {
      const enabledBefore = (settingsBefore.get('agents_enabled')?.value ?? {}) as Record<string, boolean>
      const cohortBefore = (settingsBefore.get('cohort_user_ids')?.value ?? []) as string[]
      await setSetting('agents_enabled', { ...enabledBefore, decline_message: true, compare_pointers: true })
      await setSetting('cohort_user_ids', [...new Set([...cohortBefore, buyer.uid])])
      r = await api(buyer.token, `/api/v1/rfq/${rfq1}/quote/${q2}/decline`, { reason: 'terms_unacceptable', note: 'transport unclear' }); d = await json(r)
      check('agent on: decline q2 → 200 message_source agent', r.status === 200 && d['message_source'] === 'agent', `status ${r.status} ${d['message_source']}`)
      const { data: q2row } = await admin.from('quotes').select('decline_message, decline_message_locale, decline_decision_id').eq('id', q2).maybeSingle()
      check("agent message stored in the provider's locale (hi) with decision id", q2row?.decline_message_locale === 'hi' && !!q2row?.decline_message && !!q2row?.decline_decision_id)
      const { data: inv } = await admin.from('ai_invocations').select('run_id, task_class, status').eq('user_id', buyer.uid).eq('feature', 'decline_message')
      check('one ai_invocations row: task_class decline_message, run_id null, stub', (inv ?? []).length === 1 && inv![0]!.run_id === null && inv![0]!.task_class === 'decline_message' && inv![0]!.status === 'stub', JSON.stringify(inv))
      if (q2row?.decline_decision_id) {
        const { data: dec } = await admin.from('ai_decisions').select('feature, tool, run_id, decided_by').eq('id', q2row.decline_decision_id).maybeSingle()
        check('ai_decisions row: feature decline_message, tool decline_quote, run_id null, decided_by buyer', dec?.feature === 'decline_message' && dec?.tool === 'decline_quote' && dec?.run_id === null && dec?.decided_by === buyer.uid, JSON.stringify(dec))
      }

      // Pointers ON (stub): a fresh RFQ with two live quotes.
      const rfqP = await mkRfq(`${tag} pointers`)
      const pa = await quote(p1.token, rfqP, { price_paise: 800_000, delivery_days: 6, gst_included: false })
      const pb = await quote(p2.token, rfqP, { price_paise: 850_000, delivery_days: 4, gst_included: true, transport_included: false })
      cmp = await api(buyer.token, `/api/v1/rfq/${rfqP}/compare?locale=hi`, undefined, 'GET'); cmpBody = await json(cmp)
      const ptr = cmpBody['pointers'] as { pointers: Array<{ quote_id: string; lines: string[] }>; locale: string; stub: boolean } | null
      check('pointers ON: fresh pointers for every quote id, stub:true, locale hi', cmp.status === 200 && cmpBody['pointers_source'] === 'fresh' && !!ptr && ptr.stub === true && ptr.locale === 'hi' && [pa, pb].every((id) => ptr.pointers.some((p) => p.quote_id === id)), `source ${cmpBody['pointers_source']}`)
      const { data: rfqRow } = await admin.from('rfqs').select('compare_pointers, compare_pointers_at').eq('id', rfqP).maybeSingle()
      check('rfqs.compare_pointers cache written', !!rfqRow?.compare_pointers && !!rfqRow?.compare_pointers_at)
      const { count: invBefore } = await admin.from('ai_invocations').select('id', { count: 'exact', head: true }).eq('user_id', buyer.uid).eq('feature', 'compare_pointers')
      cmp = await api(buyer.token, `/api/v1/rfq/${rfqP}/compare?locale=hi`, undefined, 'GET'); cmpBody = await json(cmp)
      const { count: invAfter } = await admin.from('ai_invocations').select('id', { count: 'exact', head: true }).eq('user_id', buyer.uid).eq('feature', 'compare_pointers')
      check('second call is a cache hit — no second ai_invocations row', cmpBody['pointers_source'] === 'cached' && invBefore === invAfter, `source ${cmpBody['pointers_source']} inv ${invBefore}→${invAfter}`)
    } else {
      skip('flag ON decline-message + pointers lifecycle', 'AGENT_ENABLED=false on this server — template + null verified instead')
    }

    // ── Auto-decline on accept (simulated checkout) ───────────────────────
    const rfqA = await mkRfq(`${tag} accept`)
    const wa = await quote(p1.token, rfqA, { price_paise: 400_000, delivery_days: 5 })
    const la = await quote(p2.token, rfqA, { price_paise: 450_000, delivery_days: 5 })
    const co = await api(buyer.token, '/api/v1/checkout', { quoteId: wa, idempotencyKey: randomUUID() })
    const cod = await json(co)
    let accepted = false
    if (co.status === 200 && cod['simulated'] && cod['checkoutSessionId']) {
      const sim = await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: cod['checkoutSessionId'] })
      const simBody = await json(sim)
      accepted = sim.status === 200 && !!simBody['orderId']
    }
    if (!accepted) {
      skip('auto-decline on accept', `checkout not simulated here (status ${co.status}${cod['simulated'] ? '' : ', not simulated'})`)
    } else {
      const { data: loser } = await admin.from('quotes').select('status, decline_reason, declined_by, declined_at, decline_decision_id').eq('id', la).maybeSingle()
      check("loser: declined / another_quote_accepted / system / declined_at, no decision id", loser?.status === 'declined' && loser?.decline_reason === 'another_quote_accepted' && loser?.declined_by === 'system' && !!loser?.declined_at && loser?.decline_decision_id === null, JSON.stringify(loser))
      const { data: winner } = await admin.from('quotes').select('status').eq('id', wa).maybeSingle()
      check('winner accepted', winner?.status === 'accepted')
      r = await api(buyer.token, `/api/v1/rfq/${rfqA}/quote/${wa}/decline`, { reason: 'other' }); d = await json(r)
      check('declining an accepted quote → 409', r.status === 409, `status ${r.status} ${d['error']}`)
      r = await api(buyer.token, `/api/v1/rfq/${rfqA}/quote/${la}/decline`, { reason: 'other' }); d = await json(r)
      check('declining on an accepted RFQ → 409', r.status === 409, `status ${r.status} ${d['error']}`)
    }
  } finally {
    // Cleanup — PostgREST returns { error } and never throws, so every delete is
    // checked, and the order follows the FK graph: checkout_sessions → order
    // children → orders → price book → quotes → extractions → RFQs → ai_* →
    // profiles → users. A silent FK failure here left kill-test rows in prod once.
    const failures: string[] = []
    const del = async (label: string, q: PromiseLike<{ error: { message: string } | null }>) => {
      const { error } = await q
      if (error) failures.push(`${label}: ${error.message}`)
    }
    try {
      const msmeIds = created.msmeIds
      if (msmeIds.length) {
        // checkout_sessions.order_id has no cascade — sessions go BEFORE orders.
        await del('checkout_sessions', admin.from('checkout_sessions').delete().in('msme_id', msmeIds))
        const { data: orders } = await admin.from('orders').select('id').in('msme_id', msmeIds)
        const orderIds = (orders ?? []).map((o) => o.id as string)
        if (orderIds.length) {
          await del('payout_dossiers', admin.from('payout_dossiers').delete().in('order_id', orderIds))
          await del('evidence_photo_hashes', admin.from('evidence_photo_hashes').delete().in('order_id', orderIds))
          await del('payouts', admin.from('payouts').delete().in('order_id', orderIds))
          await del('order_events', admin.from('order_events').delete().in('order_id', orderIds))
          await del('invoices', admin.from('invoices').delete().in('order_id', orderIds))
          const { data: pays } = await admin.from('payments').select('id').in('order_id', orderIds)
          const payIds = (pays ?? []).map((p) => p.id as string)
          if (payIds.length) await del('refunds', admin.from('refunds').delete().in('payment_id', payIds))
          await del('payments', admin.from('payments').delete().in('order_id', orderIds))
          await del('orders', admin.from('orders').delete().in('id', orderIds))
        }
      }
      if (created.rfqIds.length) {
        const { data: qs } = await admin.from('quotes').select('id').in('rfq_id', created.rfqIds)
        const quoteIds = (qs ?? []).map((q) => q.id as string)
        if (quoteIds.length) {
          await del('provider_price_book', admin.from('provider_price_book').delete().in('source_quote_id', quoteIds))
          await del('quote_events', admin.from('quote_events').delete().in('quote_id', quoteIds))
        }
        // quotes.extraction_id / decline_decision_id point at extractions and
        // decisions — quotes go first, then extractions, then (below) decisions.
        await del('quotes', admin.from('quotes').delete().in('rfq_id', created.rfqIds))
        await del('quote_extractions', admin.from('quote_extractions').delete().in('rfq_id', created.rfqIds))
        await del('rfq_matches', admin.from('rfq_matches').delete().in('rfq_id', created.rfqIds))
        await del('rfqs', admin.from('rfqs').delete().in('id', created.rfqIds))
      }
      if (created.users.length) {
        await del('ai_decisions', admin.from('ai_decisions').delete().in('decided_by', created.users))
        await del('ai_invocations', admin.from('ai_invocations').delete().in('user_id', created.users))
        await del('notifications', admin.from('notifications').delete().in('user_id', created.users))
      }
      if (created.providerIds.length) {
        await del('provider_categories', admin.from('provider_categories').delete().in('provider_id', created.providerIds))
        await del('provider_profiles', admin.from('provider_profiles').delete().in('id', created.providerIds))
      }
      if (msmeIds.length) await del('msme_profiles', admin.from('msme_profiles').delete().in('id', msmeIds))
      for (const [key, before] of settingsBefore) {
        if (before.existed) await setSetting(key, before.value)
        else await del(`agent_settings.${key}`, admin.from('agent_settings').delete().eq('key', key))
      }
      for (const uid of created.users) {
        await del('users', admin.from('users').delete().eq('id', uid))
        const { error } = await admin.auth.admin.deleteUser(uid)
        if (error) failures.push(`auth.users ${uid.slice(0, 8)}: ${error.message}`)
      }
      if (failures.length) {
        record('cleanup', 'FAIL', failures.join('; '))
      } else {
        const { count: usersLeft } = await admin.from('users').select('id', { count: 'exact', head: true }).like('email', `${tag}_%`)
        const { count: rfqsLeft } = await admin.from('rfqs').select('id', { count: 'exact', head: true }).like('title', `${tag} %`)
        check('cleanup: zero residue for this tag (users, RFQs), settings restored', (usersLeft ?? 0) === 0 && (rfqsLeft ?? 0) === 0, `users ${usersLeft} rfqs ${rfqsLeft}; ${created.users.length} users, ${created.rfqIds.length} RFQs removed`)
      }
    } catch (e) {
      record('cleanup', 'FAIL', (e as Error).message)
    }
  }
}

main()
  .catch((e) => {
    console.error(e)
    failed++
  })
  .finally(() => {
    console.log('\nverify-compare-decline\n')
    for (const r of rows) {
      const mark = r.status === 'skip' ? '⏭' : r.status === 'pass' ? '✓' : '✗'
      console.log(`  ${mark} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
    }
    const skipped = rows.filter((r) => r.status === 'skip').length
    console.log(`\n${failed === 0 ? '✅' : '❌'} ${rows.length} checks: ${rows.length - failed - skipped} pass, ${skipped} skipped, ${failed} FAIL\n`)
    process.exitCode = failed === 0 ? 0 : 1
  })
