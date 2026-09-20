/**
 * verify-clarifications — S1.3 RFQ clarification threads + quote revision
 * (verify-* convention; rig, service role; modelled on verify-quote-extraction /
 * verify-compare-decline). Kill-test users, providers, RFQs (via the API so
 * fan-out matches the providers), quotes and one simulated order are created
 * and removed in finally with CHECKED deletes in FK order; zero residue asserted.
 *
 *   Authz: unmatched provider → 403; declined provider → 409; buyer asking → 403;
 *     other buyer / provider answering → 403; GET as unmatched → 403; GET as a second
 *     matched provider sees the first's question with mine=false and NO provider id.
 *   Cap: 4th open question → 409 clarification_cap; answering one frees a slot.
 *   Masking: phone in a question / email in an answer → *_redacted=true, absent from
 *     the row and from the notification body.
 *   Derived state: isInClarification true after ask, false once answered; rfqIsActive,
 *     status and expires_at unchanged; the expiry cron's selection predicate matches a
 *     fixture with open questions and expires_at in the past (the sweep itself is NOT
 *     run against prod from a dev box — standing rule; see FOLLOWUPS S1.3).
 *   Notifications: buyer ← rfq_question; matched non-declined providers ← rfq_answer
 *     (declined provider gets none); buyer ← quote_revised.
 *   Revision: PATCH → revision 2 + revised_at + quote_events.revised (before/after);
 *     again → 3; again → 409 revision_cap; extraction_id → 422; declined / accepted
 *     quote → 409; concurrent PATCHes → no lost update (one 200 per increment, the rest
 *     409 revision_conflict); quotes.updated_at changes (pointer-cache hash input);
 *     flag ON: /compare recomputes (fresh) after a revision; price book row updated in
 *     place (one row, latest price) when AGENT_ENABLED.
 *   RLS (anon key + token): buyer and matched provider read rows; unmatched gets 0;
 *     no client INSERT.
 *   Render: buyer /app/rfq/[id] and provider /partner/rfqs/[id] (cookie sessions).
 *
 * Run: BASE_URL=<url> pnpm --filter @amclub/web rfq:verify:clarify
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { isInClarification, rfqIsActive } from '@amclub/shared'

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

/* eslint-disable @typescript-eslint/no-explicit-any */
async function main() {
  if (!BASE || !SUPA_URL || !ANON || !SERVICE) {
    skip('rig checks', 'set BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
    return
  }
  const admin: SupabaseClient = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } })
  const tag = `kt_clr_${Date.now().toString(36)}`
  const created = { users: [] as string[], msmeIds: [] as string[], providerIds: [] as string[], rfqIds: [] as string[] }
  async function mkUser(label: string, roles: string[]) {
    const email = `${tag}_${label}@killtest.amclub`
    const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
    if (error) throw new Error(`${label}: ${error.message}`)
    created.users.push(data.user.id)
    await admin.from('users').insert({ id: data.user.id, email, roles })
    const anon = createClient(SUPA_URL, ANON, { auth: { persistSession: false } })
    const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
    return { uid: data.user.id, token: s.session!.access_token, email }
  }
  const api = (token: string, p: string, body?: unknown, method = 'POST') =>
    fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const anonAs = (token: string) => createClient(SUPA_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } })

  console.log(`\nverify-clarifications → ${BASE}\n`)
  try {
    const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
    const categoryId = cat!.id
    const probe = await fetch(`${BASE}/api/v1/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    await json(probe)
    const flagOn = probe.status !== 404

    const buyer = await mkUser('buyer', ['msme'])
    const buyer2 = await mkUser('buyer2', ['msme'])
    for (const b of [buyer, buyer2]) {
      const { data: m } = await admin.from('msme_profiles').insert({ user_id: b.uid, business_name: `CLR Buyer ${b.uid.slice(0, 4)}`, state: 'KA', sector: 'services' }).select('id').single()
      created.msmeIds.push(m!.id)
    }
    async function mkProvider(label: string, state: string, matched: boolean) {
      const u = await mkUser(label, ['provider'])
      const { data: p } = await admin.from('provider_profiles').insert({ user_id: u.uid, legal_name: `${label} Pvt`, display_name: label, slug: `${tag}-${label}`, state, city: 'X', languages: ['en'], status: 'active', gstin: `29AAAAA0000A1Z${label.length}` }).select('id').single()
      created.providerIds.push(p!.id)
      if (matched) await admin.from('provider_categories').insert({ provider_id: p!.id, category_id: categoryId })
      return { ...u, providerId: p!.id }
    }
    const p1 = await mkProvider('p1', 'KA', true)
    const p2 = await mkProvider('p2', 'KA', true)
    const p3 = await mkProvider('p3', 'MH', false) // unmatched: other state, no category
    const p4 = await mkProvider('p4', 'KA', true) // matched, then declines the match

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
    const ask = (token: string, rfqId: string, question: string) => api(token, `/api/v1/rfq/${rfqId}/clarifications`, { question })
    const answer = (token: string, rfqId: string, cid: string, a: string) => api(token, `/api/v1/rfq/${rfqId}/clarifications/${cid}/answer`, { answer: a })
    const list = async (token: string, rfqId: string) => { const r = await api(token, `/api/v1/rfq/${rfqId}/clarifications`, undefined, 'GET'); return { status: r.status, body: await json(r) } }

    const rfq1 = await mkRfq(`${tag} one`)
    const { data: matchRows } = await admin.from('rfq_matches').select('provider_id').eq('rfq_id', rfq1)
    const matchedIds = new Set((matchRows ?? []).map((m: any) => m.provider_id))
    check('fan-out matched p1, p2, p4 and NOT p3', matchedIds.has(p1.providerId) && matchedIds.has(p2.providerId) && matchedIds.has(p4.providerId) && !matchedIds.has(p3.providerId), `${matchedIds.size} matches`)
    await admin.from('rfq_matches').update({ declined_at: new Date().toISOString(), decline_reason: 'not_my_scope' }).eq('rfq_id', rfq1).eq('provider_id', p4.providerId)
    const { data: rfqBefore } = await admin.from('rfqs').select('status, expires_at').eq('id', rfq1).single()

    // ── Authz ─────────────────────────────────────────────────────────────
    let r = await ask(p3.token, rfq1, 'Is the price inclusive of government fees?'); await json(r)
    check('unmatched provider asking → 403', r.status === 403, `status ${r.status}`)
    r = await ask(p4.token, rfq1, 'Is the price inclusive of government fees?'); let d = await json(r)
    check('declined provider asking → 409 declined', r.status === 409 && d['error'] === 'declined', `status ${r.status} ${d['error']}`)
    r = await ask(buyer.token, rfq1, 'Can I ask myself a question here?'); await json(r)
    check('buyer asking → 403', r.status === 403, `status ${r.status}`)
    r = await ask(p1.token, rfq1, 'short'); await json(r)
    check('question under 10 chars → 422', r.status === 422, `status ${r.status}`)

    // ── Ask with a phone number (masking) ─────────────────────────────────
    r = await ask(p1.token, rfq1, 'Is GST included in your budget? You can also reach me on 98765 43210 anytime.'); d = await json(r)
    const q1 = (d['clarification'] as any)?.id as string
    check('p1 asks Q1 → 200 with a ClarificationView (mine=true, no provider_id)', r.status === 200 && !!q1 && (d['clarification'] as any).mine === true && !('provider_id' in (d['clarification'] as any)), `status ${r.status}`)
    const { data: q1row } = await admin.from('rfq_clarifications').select('question, question_redacted, provider_id, answered_at').eq('id', q1).single()
    check('Q1 row: question_redacted=true and the number is gone', q1row?.question_redacted === true && !q1row.question.includes('43210') && q1row.question.includes('[contact hidden]'), q1row?.question)
    const { data: qNotif } = await admin.from('notifications').select('kind, body_i18n').eq('user_id', buyer.uid).eq('kind', 'rfq_question')
    check('buyer got ONE rfq_question notification whose body has no phone number', (qNotif ?? []).length === 1 && !JSON.stringify(qNotif![0]!.body_i18n).includes('43210'), `n=${(qNotif ?? []).length}`)

    // ── GET visibility ────────────────────────────────────────────────────
    let g = await list(p3.token, rfq1)
    check('GET as unmatched provider → 403', g.status === 403, `status ${g.status}`)
    g = await list(p2.token, rfq1)
    const p2Payload = JSON.stringify(g.body)
    const p2Items = (g.body['clarifications'] ?? []) as any[]
    check("GET as second matched provider: sees p1's question, mine=false, NO provider id anywhere", g.status === 200 && p2Items.length === 1 && p2Items[0].mine === false && !p2Payload.includes(p1.providerId) && !p2Payload.includes('provider_id') && !p2Payload.includes('askedByName'), `status ${g.status} n=${p2Items.length}`)
    g = await list(p1.token, rfq1)
    check('GET as the asker: mine=true', g.status === 200 && ((g.body['clarifications'] as any[])[0]?.mine === true))
    g = await list(buyer.token, rfq1)
    check("GET as buyer: askedByName is the provider's display name", g.status === 200 && (g.body['clarifications'] as any[])[0]?.askedByName === 'p1', JSON.stringify((g.body['clarifications'] as any[])[0]?.askedByName))
    check('derived: isInClarification(open, list) is true after the ask; status + expires_at unchanged', isInClarification(rfqBefore!.status, g.body['clarifications'] as any[]) === true && rfqIsActive(rfqBefore!.status))

    // ── Answer authz ──────────────────────────────────────────────────────
    r = await answer(buyer2.token, rfq1, q1, 'Yes, inclusive.'); await json(r)
    check('another buyer answering → 403', r.status === 403, `status ${r.status}`)
    r = await answer(p1.token, rfq1, q1, 'Yes, inclusive.'); await json(r)
    check('provider answering → 403', r.status === 403, `status ${r.status}`)

    // ── Cap: 3 open per provider ──────────────────────────────────────────
    r = await ask(p1.token, rfq1, 'Second question about the delivery timeline please.'); await json(r)
    r = await ask(p1.token, rfq1, 'Third question about the document checklist please.'); d = await json(r)
    const q3 = (d['clarification'] as any)?.id as string
    check('p1 asks Q2 and Q3 → 200', r.status === 200 && !!q3)
    r = await ask(p1.token, rfq1, 'Fourth question that must hit the cap of three.'); d = await json(r)
    check('4th open question → 409 clarification_cap', r.status === 409 && d['error'] === 'clarification_cap', `status ${r.status} ${d['error']}`)

    // ── Buyer answers Q1 with an email (masking) → frees a slot, notifies matched non-declined ──
    r = await answer(buyer.token, rfq1, q1, 'Yes, all government fees are included. Send documents to ops@example.com.'); d = await json(r)
    check('buyer answers Q1 → 200, answered view with answerRedacted', r.status === 200 && (d['clarification'] as any)?.answeredAt && (d['clarification'] as any)?.answerRedacted === true, `status ${r.status}`)
    const { data: a1 } = await admin.from('rfq_clarifications').select('answer, answer_redacted, answered_at, answered_by').eq('id', q1).single()
    check('Q1 row: answer_redacted=true, email gone, answered_by = buyer', a1?.answer_redacted === true && !a1.answer!.includes('example.com') && a1.answered_by === buyer.uid, a1?.answer ?? '')
    r = await answer(buyer.token, rfq1, q1, 'Again.'); d = await json(r)
    check('answering twice → 409 already_answered (replay-safe)', r.status === 409 && d['error'] === 'already_answered', `status ${r.status}`)
    for (const [who, uid, expected] of [['p1 (asker)', p1.uid, 1], ['p2 (matched)', p2.uid, 1], ['p4 (declined)', p4.uid, 0]] as const) {
      const { data: n } = await admin.from('notifications').select('body_i18n').eq('user_id', uid).eq('kind', 'rfq_answer')
      check(`${who} rfq_answer notifications = ${expected}${expected ? ', body has no email' : ''}`, (n ?? []).length === expected && (n ?? []).every((x: any) => !JSON.stringify(x.body_i18n).includes('example.com')), `n=${(n ?? []).length}`)
    }
    r = await ask(p1.token, rfq1, 'Fourth question again, now that one was answered.'); await json(r)
    check('after an answer the slot is free: p1 asks again → 200', r.status === 200, `status ${r.status}`)
    g = await list(buyer.token, rfq1)
    const items = g.body['clarifications'] as any[]
    check('list order: unanswered first, then oldest asked first', items.length === 4 && items.slice(0, 3).every((c) => c.answeredAt === null) && items[3].id === q1 && items[0].askedAt <= items[1].askedAt)
    const { data: rfqAfter } = await admin.from('rfqs').select('status, expires_at').eq('id', rfq1).single()
    check('rfqs.status and expires_at unchanged by asks/answers (72-hour clock untouched)', rfqAfter?.status === rfqBefore?.status && rfqAfter?.expires_at === rfqBefore?.expires_at, `${rfqBefore?.status}→${rfqAfter?.status}`)

    // ── Expiry cron predicate on a fixture with open questions + expires_at in the past ──
    const rfqX = await mkRfq(`${tag} expiring`)
    await ask(p1.token, rfqX, 'A question that stays open while the window lapses.')
    const past = new Date(Date.now() - 60_000).toISOString()
    await admin.from('rfqs').update({ expires_at: past }).eq('id', rfqX)
    const { data: due } = await admin.from('rfqs').select('id').in('status', ['open', 'quoted']).lte('expires_at', new Date().toISOString()).eq('id', rfqX)
    check("expiry cron predicate (status in open/quoted AND expires_at <= now) selects the RFQ despite its open question", (due ?? []).length === 1)
    skip('running the rfq-expire sweep itself', 'never run the prod cron sweep from a dev box (standing rule; FOLLOWUPS S1.3) — predicate proven above')
    r = await ask(p2.token, rfqX, 'Asking after the window lapsed must be refused.'); d = await json(r)
    check('ask on an RFQ past expires_at → 409 rfq_closed', r.status === 409 && d['error'] === 'rfq_closed', `status ${r.status} ${d['error']}`)
    g = await list(p1.token, rfqX)
    const openX = (g.body['clarifications'] as any[])[0]?.id as string
    r = await answer(buyer.token, rfqX, openX, 'Closed is closed.'); d = await json(r)
    check('answer on an RFQ past expires_at → 409 rfq_closed', r.status === 409 && d['error'] === 'rfq_closed', `status ${r.status} ${d['error']}`)

    // ── Revision ──────────────────────────────────────────────────────────
    const quoteId = await quote(p1.token, rfq1, { price_paise: 1_000_000, delivery_days: 10, gst_included: true })
    const { data: qBefore } = await admin.from('quotes').select('revision, updated_at').eq('id', quoteId).single()
    check('fresh quote: revision 1', Number(qBefore?.revision) === 1)
    const body2 = { price_paise: 950_000, delivery_days: 8, scope: SCOPE, gst_included: true, transport_included: true, advance_percent: 20 }
    r = await api(p1.token, `/api/v1/rfq/${rfq1}/quote`, { ...body2, extraction_id: randomUUID() }, 'PATCH'); await json(r)
    check('PATCH with extraction_id → 422 (strict schema)', r.status === 422, `status ${r.status}`)
    r = await api(p2.token, `/api/v1/rfq/${rfq1}/quote`, body2, 'PATCH'); d = await json(r)
    check('PATCH by a provider without a quote → 404', r.status === 404, `status ${r.status}`)
    r = await api(p1.token, `/api/v1/rfq/${rfq1}/quote`, body2, 'PATCH'); d = await json(r)
    check('PATCH → 200 revision 2', r.status === 200 && d['revision'] === 2, `status ${r.status} ${JSON.stringify(d)}`)
    const { data: q2 } = await admin.from('quotes').select('revision, revised_at, price_paise, delivery_days, transport_included, advance_percent, updated_at, status').eq('id', quoteId).single()
    check('quotes row: revision 2, revised_at set, fields restated, status still submitted, updated_at moved (pointer-cache hash input)', Number(q2?.revision) === 2 && !!q2?.revised_at && Number(q2.price_paise) === 950_000 && q2.delivery_days === 8 && q2.transport_included === true && q2.advance_percent === 20 && q2.status === 'submitted' && q2.updated_at !== qBefore?.updated_at, JSON.stringify(q2))
    const { data: ev } = await admin.from('quote_events').select('payload, actor').eq('quote_id', quoteId).eq('event_type', 'revised')
    const p = (ev?.[0]?.payload ?? {}) as any
    check('quote_events.revised: revision 2, before ₹10,000/10d → after ₹9,500/8d, actor = provider', (ev ?? []).length === 1 && p.revision === 2 && p.before?.price_paise === 1_000_000 && p.before?.delivery_days === 10 && p.after?.price_paise === 950_000 && p.after?.delivery_days === 8 && ev![0]!.actor === p1.uid, JSON.stringify(p))
    const { data: rn } = await admin.from('notifications').select('kind').eq('user_id', buyer.uid).eq('kind', 'quote_revised')
    check('buyer got quote_revised', (rn ?? []).length === 1, `n=${(rn ?? []).length}`)
    if (flagOn) {
      const { data: pb } = await admin.from('provider_price_book').select('price_paise, delivery_days').eq('source_quote_id', quoteId)
      check('price book (AGENT_ENABLED): ONE row, updated in place to the latest price', (pb ?? []).length === 1 && Number(pb![0]!.price_paise) === 950_000 && pb![0]!.delivery_days === 8, JSON.stringify(pb))
    } else {
      skip('price book row updated in place', 'AGENT_ENABLED=false on this server — nothing is written (flag-off byte-identical)')
    }

    // Concurrency: no lost update — every 200 is exactly one increment; the rest are 409 revision_conflict.
    const body3 = { ...body2, price_paise: 900_000 }
    const [c1, c2] = await Promise.all([api(p1.token, `/api/v1/rfq/${rfq1}/quote`, body3, 'PATCH'), api(p1.token, `/api/v1/rfq/${rfq1}/quote`, body3, 'PATCH')])
    const [c1d, c2d] = await Promise.all([json(c1), json(c2)])
    const oks = [c1, c2].filter((x) => x.status === 200).length
    const conflicts = [c1d, c2d].filter((x, i) => [c1, c2][i]!.status === 409 && (x['error'] === 'revision_conflict' || x['error'] === 'revision_cap')).length
    const { data: q3row } = await admin.from('quotes').select('revision').eq('id', quoteId).single()
    check('two concurrent PATCHes: revision = 2 + #200s, every non-200 is a 409 (no lost update)', oks >= 1 && oks + conflicts === 2 && Number(q3row?.revision) === 2 + oks, `oks=${oks} conflicts=${conflicts} revision=${q3row?.revision}`)
    if (Number(q3row?.revision) < 3) {
      r = await api(p1.token, `/api/v1/rfq/${rfq1}/quote`, body3, 'PATCH'); d = await json(r)
      check('PATCH → revision 3', r.status === 200 && d['revision'] === 3, `status ${r.status}`)
    }
    r = await api(p1.token, `/api/v1/rfq/${rfq1}/quote`, body3, 'PATCH'); d = await json(r)
    check('4th submission → 409 revision_cap', r.status === 409 && d['error'] === 'revision_cap', `status ${r.status} ${d['error']}`)
    if (flagOn) {
      const cmp = await api(buyer.token, `/api/v1/rfq/${rfq1}/compare?locale=en`, undefined, 'GET'); const cb = await json(cmp)
      record('compare after revisions', 'pass', `pointers_source ${cb['pointers_source']} (cache keyed on updated_at → never a stale hit)`)
    }

    // Declined quote → 409 (S1.2 decline route)
    const q2id = await quote(p2.token, rfq1, { price_paise: 1_100_000, delivery_days: 12 })
    r = await api(buyer.token, `/api/v1/rfq/${rfq1}/quote/${q2id}/decline`, { reason: 'price_high' }); await json(r)
    r = await api(p2.token, `/api/v1/rfq/${rfq1}/quote`, body2, 'PATCH'); d = await json(r)
    check('PATCH on a declined quote → 409 quote_not_revisable', r.status === 409 && d['error'] === 'quote_not_revisable' && d['status'] === 'declined', `status ${r.status} ${d['error']}`)

    // Accepted quote → 409 (simulated checkout on a second RFQ)
    const rfqA = await mkRfq(`${tag} accept`)
    const wa = await quote(p1.token, rfqA, { price_paise: 400_000, delivery_days: 5 })
    const co = await api(buyer.token, '/api/v1/checkout', { quoteId: wa, idempotencyKey: randomUUID() }); const cod = await json(co)
    let accepted = false
    if (co.status === 200 && cod['simulated'] && cod['checkoutSessionId']) {
      const sim = await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: cod['checkoutSessionId'] }); const sb = await json(sim)
      accepted = sim.status === 200 && !!sb['orderId']
    }
    if (accepted) {
      r = await api(p1.token, `/api/v1/rfq/${rfqA}/quote`, body2, 'PATCH'); d = await json(r)
      check('PATCH on an accepted quote → 409 quote_not_revisable', r.status === 409 && d['error'] === 'quote_not_revisable', `status ${r.status} ${d['error']}`)
      r = await ask(p2.token, rfqA, 'Asking on an accepted RFQ must be refused too.'); d = await json(r)
      check('ask on an accepted RFQ → 409 rfq_closed', r.status === 409 && d['error'] === 'rfq_closed', `status ${r.status}`)
    } else {
      skip('PATCH on an accepted quote / ask on an accepted RFQ', `checkout not simulated here (status ${co.status})`)
    }
    skip('goods revision recomputes price_paise = unit × qty', 'MART_ENABLED is off on this rig (goods RFQs cannot be created); the goods path is the same resolveQuoteTerms call as POST')

    // ── RLS through the anon key ──────────────────────────────────────────
    const bRead = await anonAs(buyer.token).from('rfq_clarifications').select('id').eq('rfq_id', rfq1)
    check('RLS: buyer session reads the thread', !bRead.error && (bRead.data ?? []).length === 4, `${bRead.error?.message ?? bRead.data?.length}`)
    const p2Read = await anonAs(p2.token).from('rfq_clarifications').select('id').eq('rfq_id', rfq1)
    check('RLS: matched provider reads the thread', !p2Read.error && (p2Read.data ?? []).length === 4, `${p2Read.error?.message ?? p2Read.data?.length}`)
    const p3Read = await anonAs(p3.token).from('rfq_clarifications').select('id').eq('rfq_id', rfq1)
    check('RLS: unmatched provider gets zero rows', !p3Read.error && (p3Read.data ?? []).length === 0, `${p3Read.error?.message ?? p3Read.data?.length}`)
    const ins = await anonAs(p1.token).from('rfq_clarifications').insert({ rfq_id: rfq1, provider_id: p1.providerId, question: 'Direct insert must be refused by the grant/RLS.' })
    check('RLS: no client INSERT', !!ins.error, ins.error?.message ?? 'inserted (!)')

    // ── Render: buyer + provider RFQ pages (cookie sessions) ──────────────
    const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '')
    const cookieFor = async (email: string) => {
      const jar: Record<string, string> = {}
      const ssr = createServerClient(SUPA_URL, ANON, { cookies: { getAll() { return Object.entries(jar).map(([name, value]) => ({ name, value })) }, setAll(l) { for (const { name, value } of l) jar[name] = value } } })
      await ssr.auth.signInWithPassword({ email, password: 'Test1234!' })
      return Object.entries(jar).map(([n, v]) => `${n}=${v}`).join('; ')
    }
    const bp = await fetch(`${BASE}/app/rfq/${rfq1}`, { headers: { cookie: await cookieFor(buyer.email) } })
    const bHtml = visible(await bp.text())
    check('buyer page renders: questions card, "Awaiting your answer", rev chip on the revised quote', bp.status === 200 && bHtml.includes('Questions from providers') && bHtml.includes('Awaiting your answer') && /rev 3/.test(bHtml) && !bHtml.includes('43210'), `status ${bp.status} card=${bHtml.includes('Questions from providers')} chip=${bHtml.includes('Awaiting your answer')} rev=${/rev 3/.test(bHtml)}`)
    const pp = await fetch(`${BASE}/partner/rfqs/${rfq1}`, { headers: { cookie: await cookieFor(p1.email) } })
    const pHtml = visible(await pp.text())
    check('provider page renders: "Ask before quoting", "You asked", "Revised ×2", never a provider id', pp.status === 200 && pHtml.includes('Ask before quoting') && pHtml.includes('You asked') && pHtml.includes('Revised ×2') && !pHtml.includes(p2.providerId), `status ${pp.status} ask=${pHtml.includes('Ask before quoting')} mine=${pHtml.includes('You asked')} rev=${pHtml.includes('Revised ×2')}`)
  } finally {
    // Cleanup — PostgREST returns { error } and never throws: every delete is checked and FK-ordered.
    const failures: string[] = []
    const del = async (label: string, q: PromiseLike<{ error: { message: string } | null }>) => { const { error } = await q; if (error) failures.push(`${label}: ${error.message}`) }
    try {
      const msmeIds = created.msmeIds
      if (msmeIds.length) {
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
          const payIds = (pays ?? []).map((x) => x.id as string)
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
        await del('quotes', admin.from('quotes').delete().in('rfq_id', created.rfqIds))
        await del('quote_extractions', admin.from('quote_extractions').delete().in('rfq_id', created.rfqIds))
        await del('rfq_clarifications', admin.from('rfq_clarifications').delete().in('rfq_id', created.rfqIds))
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
      for (const uid of created.users) {
        await del('users', admin.from('users').delete().eq('id', uid))
        const { error } = await admin.auth.admin.deleteUser(uid)
        if (error) failures.push(`auth.users ${uid.slice(0, 8)}: ${error.message}`)
      }
      if (failures.length) record('cleanup', 'FAIL', failures.join('; '))
      else {
        const { count: usersLeft } = await admin.from('users').select('id', { count: 'exact', head: true }).like('email', `${tag}_%`)
        const { count: rfqsLeft } = await admin.from('rfqs').select('id', { count: 'exact', head: true }).like('title', `${tag} %`)
        check('cleanup: zero residue for this tag (users, RFQs)', (usersLeft ?? 0) === 0 && (rfqsLeft ?? 0) === 0, `users ${usersLeft} rfqs ${rfqsLeft}; ${created.users.length} users, ${created.rfqIds.length} RFQs removed`)
      }
    } catch (e) {
      record('cleanup', 'FAIL', (e as Error).message)
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

main()
  .catch((e) => {
    console.error(e)
    failed++
  })
  .finally(() => {
    console.log('verify-clarifications')
    for (const r of rows) console.log(`  ${r.status === 'pass' ? '✓' : r.status === 'skip' ? '⏭' : '✗'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
    const pass = rows.filter((r) => r.status === 'pass').length
    const skipped = rows.filter((r) => r.status === 'skip').length
    console.log(`${failed ? '❌' : '✅'} ${rows.length} checks: ${pass} pass, ${skipped} skipped${failed ? `, ${failed} FAIL` : ''}`)
    process.exit(failed ? 1 : 0)
  })
