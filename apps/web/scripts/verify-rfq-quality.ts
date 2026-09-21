/**
 * verify-rfq-quality — S1.5 two-phase RFQ create (pre-fan-out completeness)
 * (verify-* convention; rig, service role; modelled on verify-quote-extraction).
 *
 * Needs BASE_URL + NEXT_PUBLIC_SUPABASE_URL/ANON_KEY + SUPABASE_SERVICE_ROLE_KEY.
 * Optional FAIL_BASE_URL: a second local server started with an unreachable LLM
 * endpoint + a fake key, to prove the model-failure path (rule-only report,
 * invocation row status 'error'). Kill-test users / RFQs are created and removed
 * in finally with CHECKED, FK-ordered deletes; agent_settings touched are
 * restored; zero residue asserted.
 *
 *   Flag OFF (or buyer not in cohort): POST /rfq reply is exactly { rfqId, matched },
 *     fanout_at set, rfq_matches written, quality_report null, no ai_* rows.
 *   Flag ON + cohort (stub): complete fixture → quality.complete, decision 'skipped',
 *     inline fan-out, one ai_invocations row (task rfq_quality, run_id null);
 *     incomplete fixture → deferred, ≤ 3 missing (rule items first), contact risk,
 *     NO rfq_matches, fanout_at NULL.
 *   Answer: unknown field → 422; other buyer → 403; valid answers merged + masked,
 *     one ai_decisions row (feature rfq_quality, tool check_rfq_quality), decision
 *     'answered', fan-out done; second answer → 409 already_sent.
 *   Send as is: decision 'sent_as_is', one ai_decisions row, fan-out done.
 *   Cron guard: the sweep's exact predicate selects an old deferred fixture (query
 *     only — never the prod sweep); releaseDeferredRfq called directly (server-only
 *     stubbed) → released once, second call released:false, matches unchanged;
 *     two concurrent releases → exactly one released:true. Falls back to a route
 *     race when the direct import is not possible on this rig.
 *   Backfill: no pre-existing RFQ has fanout_at NULL.
 *   Render: buyer /app/rfq/[id] shows the questions card while deferred.
 *
 * Run: BASE_URL=<url> [FAIL_BASE_URL=<url>] pnpm --filter @amclub/web agents:verify:rfq-quality
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import Module from 'node:module'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'

const BASE = (process.env['BASE_URL'] || '').replace(/\/$/, '')
const FAIL_BASE = (process.env['FAIL_BASE_URL'] || '').replace(/\/$/, '')
const SUPA_URL = process.env['NEXT_PUBLIC_SUPABASE_URL'] || ''
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] || ''
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY'] || ''

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

const NOTES_LONG = 'Proprietorship trading in electrical fittings with two GSTINs (Karnataka and Tamil Nadu), Tally Prime books, GSTR-1 and GSTR-3B every month plus annual reconciliation with 2A/2B.'
const COMPLETE = { category_slug: 'tax-accounting', title: 'Monthly GST returns for a trading firm in Karnataka', details: { filing_type: 'GST Return (Monthly)', financial_year: '2025-26', turnover_range: '₹1–5 crore', transactions_per_month: '200–500', notes: NOTES_LONG }, budget_max_paise: 600_000, needed_by: '2026-10-10' }
const INCOMPLETE = { category_slug: 'tax-accounting', title: 'GST help', details: { filing_type: 'GST Return (Monthly)', notes: 'call me on 98765 43210' } }

/** Import the web release helper outside Next: `server-only` is resolved to its empty build. */
async function loadRelease(): Promise<null | ((admin: SupabaseClient, rfqId: string, decision: 'auto_released') => Promise<{ released: boolean; matched: number }>)> {
  try {
    const m = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string }
    const orig = m._resolveFilename
    // `server-only` exports only '.', so resolve the throwing index.js and take its sibling empty.js.
    const empty = path.join(path.dirname(require.resolve('server-only')), 'empty.js')
    m._resolveFilename = function (request: string, ...rest: unknown[]) {
      if (request === 'server-only') return empty
      return orig.call(this, request, ...rest)
    }
    const mod = (await import('../lib/rfq/release')) as { releaseDeferredRfq: (admin: SupabaseClient, rfqId: string, decision: 'auto_released') => Promise<{ released: boolean; matched: number }> }
    return mod.releaseDeferredRfq
  } catch (e) {
    console.error('  (direct import of lib/rfq/release not possible here:', (e as Error).message.split('\n')[0], ')')
    return null
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function main() {
  if (!BASE || !SUPA_URL || !ANON || !SERVICE) {
    skip('rig checks', 'set BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
    return
  }
  const admin: SupabaseClient = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } })
  const startedAt = new Date().toISOString()
  const tag = `kt_rq_${Date.now().toString(36)}`
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
    await admin.from('users').insert({ id: data.user.id, email, roles, preferred_locale: 'en' })
    const anon = createClient(SUPA_URL, ANON, { auth: { persistSession: false } })
    const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
    return { uid: data.user.id, token: s.session!.access_token, email }
  }
  const api = (base: string, token: string, p: string, body?: unknown, method = 'POST') =>
    fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
  // Page renders (cookie session) — next-intl inlines the message bundle in a <script>, so only visible markup counts.
  const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '')
  const cookieFor = async (email: string) => {
    const jar: Record<string, string> = {}
    const ssr = createServerClient(SUPA_URL, ANON, { cookies: { getAll() { return Object.entries(jar).map(([name, value]) => ({ name, value })) }, setAll(l) { for (const { name, value } of l) jar[name] = value } } })
    await ssr.auth.signInWithPassword({ email, password: 'Test1234!' })
    return Object.entries(jar).map(([n, v]) => `${n}=${v}`).join('; ')
  }
  const rfqRow = (id: string) => admin.from('rfqs').select('id, status, fanout_at, quality_report, quality_checked_at, quality_decision, quality_decision_at, quality_decision_id, details, created_at').eq('id', id).single()
  const matches = async (id: string) => (await admin.from('rfq_matches').select('provider_id', { count: 'exact', head: true }).eq('rfq_id', id)).count ?? 0
  const invocations = async (uid: string) => (await admin.from('ai_invocations').select('id, run_id, task_class, status').eq('user_id', uid).eq('feature', 'rfq_quality')).data ?? []
  const decisions = async (uid: string) => (await admin.from('ai_decisions').select('id, feature, tool, run_id, final').eq('decided_by', uid).eq('feature', 'rfq_quality')).data ?? []

  console.log(`\nverify-rfq-quality → ${BASE}${FAIL_BASE ? `  (model-failure server ${FAIL_BASE})` : ''}\n`)
  try {
    const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
    const categoryId = cat!.id
    const probe = await fetch(`${BASE}/api/v1/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    await json(probe)
    const flagOn = probe.status !== 404

    // Backfill: nothing that existed before this run is left with fanout_at NULL.
    const { count: unfilled } = await admin.from('rfqs').select('id', { count: 'exact', head: true }).is('fanout_at', null).lt('created_at', startedAt)
    check('backfill: no pre-existing RFQ has fanout_at NULL', (unfilled ?? 0) === 0, `n=${unfilled}`)

    const buyer = await mkUser('buyer', ['msme'])
    const buyer2 = await mkUser('buyer2', ['msme'])
    for (const b of [buyer, buyer2]) {
      const { data: m } = await admin.from('msme_profiles').insert({ user_id: b.uid, business_name: `RQ Buyer ${b.uid.slice(0, 4)}`, state: 'KA', sector: 'services' }).select('id').single()
      created.msmeIds.push(m!.id)
    }
    for (const label of ['p1', 'p2']) {
      const u = await mkUser(label, ['provider'])
      const { data: p } = await admin.from('provider_profiles').insert({ user_id: u.uid, legal_name: `${label} Pvt`, display_name: label, slug: `${tag}-${label}`, state: 'KA', city: 'X', languages: ['en'], status: 'active', gstin: `29AAAAA0000A1Z${label.length}` }).select('id').single()
      created.providerIds.push(p!.id)
      await admin.from('provider_categories').insert({ provider_id: p!.id, category_id: categoryId })
    }

    const create = async (base: string, token: string, body: Record<string, unknown>) => {
      const r = await api(base, token, '/api/v1/rfq', body)
      const d = await json(r)
      if (d['rfqId']) created.rfqIds.push(d['rfqId'] as string)
      return { status: r.status, d }
    }

    // ── Single phase: flag OFF, or flag ON with the buyer NOT in the cohort ──
    if (flagOn) {
      for (const k of ['agents_enabled', 'cohort_user_ids']) await remember(k)
      const enabledBefore = (settingsBefore.get('agents_enabled')?.value ?? {}) as Record<string, boolean>
      const cohortBefore = (settingsBefore.get('cohort_user_ids')?.value ?? []) as string[]
      await setSetting('agents_enabled', { ...enabledBefore, rfq_quality: true })
      await setSetting('cohort_user_ids', cohortBefore.filter((u) => u !== buyer.uid))
    }
    {
      const { status, d } = await create(BASE, buyer.token, { ...INCOMPLETE, title: `${tag} single-phase incomplete` })
      check(`${flagOn ? 'flag ON, buyer not in cohort' : 'flag OFF'}: POST /rfq → 200 with exactly { rfqId, matched } (no quality key)`, status === 200 && Object.keys(d).sort().join(',') === 'matched,rfqId', `status ${status} keys=${Object.keys(d).join(',')}`)
      const { data: row } = await rfqRow(d['rfqId'] as string)
      check('single phase: fanout_at set, matches written, quality_report null, decision null', !!row?.fanout_at && (await matches(row!.id)) === 2 && row?.quality_report === null && row?.quality_decision === null, JSON.stringify({ fanout_at: row?.fanout_at, matches: await matches(row!.id) }))
      check('single phase: no ai_invocations / ai_decisions rows for the buyer', (await invocations(buyer.uid)).length === 0 && (await decisions(buyer.uid)).length === 0)
      // Render: the create page and the detail page of a single-phase RFQ (against this DB, cookie session).
      const cookie = await cookieFor(buyer.email)
      const createPage = await fetch(`${BASE}/app/rfq/new`, { headers: { cookie } })
      const createHtml = visible(await createPage.text())
      check('buyer create page renders (200, "Post a requirement")', createPage.status === 200 && createHtml.includes('Post a requirement'), `status ${createPage.status}`)
      const detailPage = await fetch(`${BASE}/app/rfq/${d['rfqId']}`, { headers: { cookie } })
      const detailHtml = visible(await detailPage.text())
      check('buyer detail page renders a single-phase RFQ (200, title, no quality card)', detailPage.status === 200 && detailHtml.includes(`${tag} single-phase incomplete`) && !detailHtml.includes('Before we send this'), `status ${detailPage.status}`)
    }

    if (!flagOn) {
      skip('flag ON two-phase lifecycle (complete / deferred / answer / send / cron guard / render)', 'AGENT_ENABLED=false on this server — single phase verified instead')
    } else {
      const enabledBefore = (settingsBefore.get('agents_enabled')?.value ?? {}) as Record<string, boolean>
      const cohortBefore = (settingsBefore.get('cohort_user_ids')?.value ?? []) as string[]
      await setSetting('agents_enabled', { ...enabledBefore, rfq_quality: true })
      await setSetting('cohort_user_ids', [...new Set([...cohortBefore, buyer.uid])])

      // ── Complete fixture → checked, nothing to ask, released inline ──
      {
        const { status, d } = await create(BASE, buyer.token, { ...COMPLETE, title: `${tag} ${COMPLETE.title}` })
        const q = d['quality'] as any
        check('complete fixture: 200, quality.complete=true, matched 2, no deferred flag', status === 200 && q?.complete === true && d['matched'] === 2 && !d['deferred'], `status ${status} ${JSON.stringify(q)}`)
        const { data: row } = await rfqRow(d['rfqId'] as string)
        check("complete fixture: decision 'skipped', fanout_at set, report written, matches 2", row?.quality_decision === 'skipped' && !!row?.fanout_at && !!row?.quality_report && (await matches(row!.id)) === 2, JSON.stringify({ decision: row?.quality_decision }))
        const inv = await invocations(buyer.uid)
        check('complete fixture: ONE ai_invocations row (task rfq_quality, run_id null)', inv.length === 1 && inv[0]!.task_class === 'rfq_quality' && inv[0]!.run_id === null, JSON.stringify(inv))
      }

      // ── Incomplete fixture → deferred ──
      // ≥ 10 chars for rfqSchema, still vague after stop-words ("help", "needed" are stop-words → one content word).
      const { status: s2, d: d2 } = await create(BASE, buyer.token, { ...INCOMPLETE, title: 'GST help needed' })
      const rfqD = d2['rfqId'] as string
      const report = d2['quality'] as any
      const missing = (report?.missing ?? []) as { field: string; source: string; question: string }[]
      const ruleFirst = missing.every((m, i) => m.source === 'rule' || missing.slice(0, i).every((x) => x.source === 'rule'))
      check('incomplete fixture: 200, deferred=true, 1..3 missing, rule items first, deadline_at present', s2 === 200 && d2['deferred'] === true && missing.length >= 1 && missing.length <= 3 && ruleFirst && typeof d2['deadline_at'] === 'string' && d2['matched'] === 0, `status ${s2} missing=${missing.map((m) => `${m.source}:${m.field}`).join(',')}`)
      check('incomplete fixture: risk_flags has contact_info_in_text; required fields lead the list', (report?.risk_flags ?? []).includes('contact_info_in_text') && missing[0]?.field === 'financial_year' && missing[1]?.field === 'turnover_range', JSON.stringify(report?.risk_flags))
      {
        const { data: row } = await rfqRow(rfqD)
        check('incomplete fixture: fanout_at NULL, NO rfq_matches, report + checked_at written, status open', row?.fanout_at === null && (await matches(rfqD)) === 0 && !!row?.quality_report && !!row?.quality_checked_at && row?.status === 'open')
        const inv = await invocations(buyer.uid)
        check('two ai_invocations rows so far (one per create), all run_id null', inv.length === 2 && inv.every((i) => i.run_id === null), `n=${inv.length}`)
      }

      // ── Render: the buyer page shows the questions card while deferred ──
      {
        const cookie = await cookieFor(buyer.email)
        const res = await fetch(`${BASE}/app/rfq/${rfqD}`, { headers: { cookie } })
        const html = visible(await res.text())
        check('buyer page renders the questions card + "Questions before sending" chip while deferred', res.status === 200 && html.includes('Before we send this') && html.includes('Questions before sending') && html.includes('Send as is'), `status ${res.status} card=${html.includes('Before we send this')} chip=${html.includes('Questions before sending')}`)
      }

      // ── Answer authz + merge ──
      let r = await api(BASE, buyer2.token, `/api/v1/rfq/${rfqD}/quality/answer`, { answers: { financial_year: '2025-26' } }); await json(r)
      check('another buyer answering → 403', r.status === 403, `status ${r.status}`)
      r = await api(BASE, buyer.token, `/api/v1/rfq/${rfqD}/quality/answer`, { answers: { not_a_field: 'x' } }); let d = await json(r)
      check('unknown field → 422 unknown_field', r.status === 422 && d['error'] === 'unknown_field', `status ${r.status} ${d['error']}`)
      r = await api(BASE, buyer.token, `/api/v1/rfq/${rfqD}/quality/answer`, { answers: {} }); await json(r)
      check('empty answers → 422', r.status === 422, `status ${r.status}`)
      const answerFields = missing.slice(0, 2).map((m) => m.field)
      r = await api(BASE, buyer.token, `/api/v1/rfq/${rfqD}/quality/answer`, { answers: { [answerFields[0]!]: '2025-26, reach me at ops@example.com', [answerFields[1]!]: '₹1–5 crore' } }); d = await json(r)
      check('valid answers → 200 matched 2, redacted_fields names the masked one', r.status === 200 && d['matched'] === 2 && JSON.stringify(d['redacted_fields']) === JSON.stringify([answerFields[0]]), `status ${r.status} ${JSON.stringify(d)}`)
      {
        const { data: row } = await rfqRow(rfqD)
        const det = (row?.details ?? {}) as Record<string, string>
        check("answered: details merged + masked, decision 'answered', decision id set, fanout_at set, matches 2", det[answerFields[0]!]?.includes('[contact hidden]') === true && !det[answerFields[0]!]?.includes('example.com') && det[answerFields[1]!] === '₹1–5 crore' && row?.quality_decision === 'answered' && !!row?.quality_decision_id && !!row?.fanout_at && (await matches(rfqD)) === 2, JSON.stringify({ decision: row?.quality_decision, det }))
        const dec = await decisions(buyer.uid)
        check('answered: ONE ai_decisions row (feature rfq_quality, tool check_rfq_quality, run_id null, final.decision answered)', dec.length === 1 && dec[0]!.tool === 'check_rfq_quality' && dec[0]!.run_id === null && (dec[0]!.final as any)?.decision === 'answered', JSON.stringify(dec))
      }
      r = await api(BASE, buyer.token, `/api/v1/rfq/${rfqD}/quality/answer`, { answers: { [answerFields[1]!]: 'again' } }); d = await json(r)
      check('second answer → 409 already_sent', r.status === 409 && d['error'] === 'already_sent', `status ${r.status} ${d['error']}`)

      // ── Send as is ──
      const { d: d3 } = await create(BASE, buyer.token, { ...INCOMPLETE, title: 'GST help two' })
      const rfqS = d3['rfqId'] as string
      r = await api(BASE, buyer.token, `/api/v1/rfq/${rfqS}/quality/send`, {}); d = await json(r)
      const { data: rowS } = await rfqRow(rfqS)
      check("send as is → 200, decision 'sent_as_is', fan-out done, second ai_decisions row", r.status === 200 && d['matched'] === 2 && rowS?.quality_decision === 'sent_as_is' && !!rowS?.fanout_at && (await matches(rfqS)) === 2 && (await decisions(buyer.uid)).length === 2, `status ${r.status} ${rowS?.quality_decision}`)
      r = await api(BASE, buyer.token, `/api/v1/rfq/${rfqS}/quality/send`, {}); d = await json(r)
      check('send as is twice → 409 already_sent', r.status === 409 && d['error'] === 'already_sent', `status ${r.status}`)

      // ── Cron guard: predicate + the release helper ──
      const { d: d4 } = await create(BASE, buyer.token, { ...INCOMPLETE, title: 'GST help three' })
      const rfqC = d4['rfqId'] as string
      const { data: holdRow } = await admin.from('agent_settings').select('value').eq('key', 'rfq_quality_hold_minutes').maybeSingle()
      const hold = typeof holdRow?.value === 'number' ? (holdRow.value as number) : 30
      const oldCreated = new Date(Date.now() - (hold + 5) * 60_000).toISOString()
      await admin.from('rfqs').update({ created_at: oldCreated }).eq('id', rfqC)
      const cutoff = new Date(Date.now() - hold * 60_000).toISOString()
      const { data: due } = await admin.from('rfqs').select('id').is('fanout_at', null).eq('status', 'open').lte('created_at', cutoff).eq('id', rfqC)
      check(`cron guard predicate (fanout_at IS NULL AND status=open AND created_at <= now - ${hold} min) selects the old deferred fixture`, (due ?? []).length === 1)
      skip('running the rfq-expire sweep itself', 'never run the prod cron sweep from a dev box (standing rule) — predicate proven, helper exercised below')
      const release = await loadRelease()
      if (release) {
        const [a, b] = await Promise.all([release(admin, rfqC, 'auto_released'), release(admin, rfqC, 'auto_released')])
        const wins = [a, b].filter((x) => x.released).length
        const { data: rowC } = await rfqRow(rfqC)
        check("releaseDeferredRfq: two concurrent calls → exactly one released:true, decision 'auto_released', matches 2 (not doubled)", wins === 1 && rowC?.quality_decision === 'auto_released' && !!rowC?.fanout_at && (await matches(rfqC)) === 2, `wins=${wins} matches=${await matches(rfqC)}`)
        const again = await release(admin, rfqC, 'auto_released')
        check('releaseDeferredRfq again → released:false, matches unchanged (idempotent)', again.released === false && (await matches(rfqC)) === 2)
        check('auto-release records NO ai_decisions row (no human)', (await decisions(buyer.uid)).length === 2)
      } else {
        // Same guarded UPDATE, exercised through the route: two concurrent send-as-is → one 200, one 409.
        const [ra, rb] = await Promise.all([api(BASE, buyer.token, `/api/v1/rfq/${rfqC}/quality/send`, {}), api(BASE, buyer.token, `/api/v1/rfq/${rfqC}/quality/send`, {})])
        await Promise.all([json(ra), json(rb)])
        const oks = [ra, rb].filter((x) => x.status === 200).length
        check('release race via the route: two concurrent sends → exactly one 200 and one 409, matches 2', oks === 1 && [ra, rb].some((x) => x.status === 409) && (await matches(rfqC)) === 2, `statuses ${ra.status},${rb.status}`)
        skip('releaseDeferredRfq direct call (auto_released)', 'lib import not possible on this rig — guarded release proven through the route race')
      }

      // ── Model failure path (second server with an unreachable LLM) ──
      if (FAIL_BASE) {
        const { status, d: df } = await create(FAIL_BASE, buyer.token, { ...INCOMPLETE, title: 'GST help fail' })
        const rep = df['quality'] as any
        const allRule = ((rep?.missing ?? []) as { source: string }[]).every((m) => m.source === 'rule')
        check('model failure: 200, deferred with RULE-ONLY questions, quality_meta.model_used=false', status === 200 && df['deferred'] === true && allRule && (df['quality_meta'] as any)?.model_used === false, `status ${status} ${JSON.stringify(df['quality_meta'])}`)
        const inv = await invocations(buyer.uid)
        check("model failure: an ai_invocations row with status 'error'", inv.some((i) => i.status === 'error'), JSON.stringify(inv.map((i) => i.status)))
      } else {
        skip('model failure path', 'set FAIL_BASE_URL to a local server started with an unreachable LLM endpoint + a fake key')
      }
    }
  } finally {
    const failures: string[] = []
    const del = async (label: string, q: PromiseLike<{ error: { message: string } | null }>) => { const { error } = await q; if (error) failures.push(`${label}: ${error.message}`) }
    try {
      if (created.rfqIds.length) {
        await del('rfq_clarifications', admin.from('rfq_clarifications').delete().in('rfq_id', created.rfqIds))
        await del('quotes', admin.from('quotes').delete().in('rfq_id', created.rfqIds))
        await del('rfq_matches', admin.from('rfq_matches').delete().in('rfq_id', created.rfqIds))
        // quality_decision_id → ai_decisions: clear the link before the decisions go.
        await del('rfqs.quality_decision_id', admin.from('rfqs').update({ quality_decision_id: null }).in('id', created.rfqIds))
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
      if (created.msmeIds.length) await del('msme_profiles', admin.from('msme_profiles').delete().in('id', created.msmeIds))
      for (const [key, before] of settingsBefore) {
        if (before.existed) await setSetting(key, before.value)
        else await del(`agent_settings.${key}`, admin.from('agent_settings').delete().eq('key', key))
      }
      for (const uid of created.users) {
        await del('users', admin.from('users').delete().eq('id', uid))
        const { error } = await admin.auth.admin.deleteUser(uid)
        if (error) failures.push(`auth.users ${uid.slice(0, 8)}: ${error.message}`)
      }
      if (failures.length) record('cleanup', 'FAIL', failures.join('; '))
      else {
        const { count: usersLeft } = await admin.from('users').select('id', { count: 'exact', head: true }).like('email', `${tag}_%`)
        const { count: rfqsLeft } = await admin.from('rfqs').select('id', { count: 'exact', head: true }).in('id', created.rfqIds.length ? created.rfqIds : ['00000000-0000-0000-0000-000000000000'])
        check('cleanup: zero residue for this tag (users, RFQs), settings restored', (usersLeft ?? 0) === 0 && (rfqsLeft ?? 0) === 0, `users ${usersLeft} rfqs ${rfqsLeft}; ${created.users.length} users, ${created.rfqIds.length} RFQs removed`)
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
    console.log('verify-rfq-quality')
    for (const r of rows) console.log(`  ${r.status === 'pass' ? '✓' : r.status === 'skip' ? '⏭' : '✗'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
    const pass = rows.filter((r) => r.status === 'pass').length
    const skipped = rows.filter((r) => r.status === 'skip').length
    console.log(`${failed ? '❌' : '✅'} ${rows.length} checks: ${pass} pass, ${skipped} skipped${failed ? `, ${failed} FAIL` : ''}`)
    process.exit(failed ? 1 : 0)
  })
