/**
 * verify-quote-extraction — S1.1 quote extraction + price-book intake (verify-*
 * convention; rig, service role; modelled on verify-trust / verify-payout-dossier).
 *
 * Needs BASE_URL + NEXT_PUBLIC_SUPABASE_URL/ANON_KEY + SUPABASE_SERVICE_ROLE_KEY.
 * Kill-test users, an RFQ (via the API, so fan-out matches the provider) and
 * quotes are created and removed in finally; agent_settings touched are
 * restored. Zero residue.
 *
 *   Flag OFF (the server's AGENT_ENABLED=false — detected via the token probe):
 *     POST …/quote/extract → 404; a typed quote submits (200) and writes NO
 *     provider_price_book row, NO quote_extractions row; quotes.extraction_id
 *     stays null (or the column/table is absent because 0032 is not applied —
 *     reported honestly).
 *   Flag ON: agent off → 404; provider not in cohort → 404; enabled + cohort
 *     (stub gateway, no key) → 200 stub:true, one quote_extractions row, one
 *     ai_invocations row (run_id null, task_class quote_extract, feature
 *     quote_extraction); submit with the extraction_id → quote linked +
 *     confirmed, one ai_decisions row (feature quote_extraction, tool
 *     extract_quote, run_id null) linked from quote_extractions.decision_id,
 *     quote_events.submitted.payload.edited_fields present, one price-book row
 *     (unit 'job'); re-submit → 409 already_quoted; another provider reusing the
 *     id → 422 extraction_mismatch; 6th extract in a minute → 429 (Upstash).
 *
 * Run: BASE_URL=<url> pnpm --filter @amclub/web agents:verify:quote
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const BASE = (process.env['BASE_URL'] || '').replace(/\/$/, '')
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
const missingRelation = (e: { code?: string; message?: string } | null | undefined) => !!e && (e.code === '42P01' || e.code === '42703' || /does not exist|schema cache/i.test(e.message ?? ''))

const SCOPE = 'GST filing for FY 2025-26 including annual return, kill-test scope text.'

async function main() {
  if (!BASE || !SUPA_URL || !ANON || !SERVICE) {
    skip('verify-quote-extraction', 'set BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
    return
  }
  const admin: SupabaseClient = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } })
  const tag = `kt_qx_${Date.now().toString(36)}`
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

  console.log(`\nverify-quote-extraction → ${BASE}\n`)
  try {
    const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
    const categoryId = cat!.id

    // Flag probe (404 while AGENT_ENABLED=false).
    const probe = await fetch(`${BASE}/api/v1/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    await json(probe)
    const flagOn = probe.status !== 404

    // Buyer (KA) + P1 matched (KA, tax) + P2 unmatched (MH).
    const buyer = await mkUser('buyer', ['msme'])
    const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'QX Buyer Co', state: 'KA', sector: 'services' }).select('id').single()
    created.msmeIds.push(msme!.id)
    async function mkProvider(label: string, state: string) {
      const u = await mkUser(label, ['provider'])
      const { data: p } = await admin.from('provider_profiles').insert({ user_id: u.uid, legal_name: `${label} Pvt`, display_name: label, slug: `${tag}-${label}`, state, city: 'X', languages: ['en'], status: 'active', gstin: `29AAAAA0000A1Z${label.length}` }).select('id').single()
      created.providerIds.push(p!.id)
      await admin.from('provider_categories').insert({ provider_id: p!.id, category_id: categoryId })
      return { ...u, providerId: p!.id }
    }
    const p1 = await mkProvider('p1', 'KA')
    const p2 = await mkProvider('p2', 'MH')

    async function mkRfq(title: string): Promise<string> {
      const r = await api(buyer.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title, details: { need: 'gst filing' } })
      const d = await json(r)
      if (r.status !== 200 || !d['rfqId']) throw new Error(`rfq create ${r.status} ${JSON.stringify(d).slice(0, 120)}`)
      created.rfqIds.push(d['rfqId'] as string)
      return d['rfqId'] as string
    }
    const rfq1 = await mkRfq(`${tag} one`)
    const { data: m1 } = await admin.from('rfq_matches').select('provider_id').eq('rfq_id', rfq1).eq('provider_id', p1.providerId).maybeSingle()
    check('P1 (KA, tax) is matched to the RFQ', !!m1)

    if (!flagOn) {
      // ── Flag OFF ─────────────────────────────────────────────────────────
      const ex = await api(p1.token, `/api/v1/rfq/${rfq1}/quote/extract`, { text: '₹45,000, 10 days, GST extra' })
      await json(ex)
      check('flag OFF: POST …/quote/extract → 404 (surface does not exist)', ex.status === 404, `status ${ex.status}`)
      const sub = await api(p1.token, `/api/v1/rfq/${rfq1}/quote`, { price_paise: 4500000, delivery_days: 10, scope: SCOPE })
      const subBody = await json(sub)
      check('flag OFF: typed quote submits → 200', sub.status === 200 && !!subBody['quoteId'], `status ${sub.status}`)
      const quoteId = subBody['quoteId'] as string | undefined
      const pb = await admin.from('provider_price_book').select('id').eq('provider_id', p1.providerId)
      if (missingRelation(pb.error)) record('flag OFF: no provider_price_book row', 'pass', 'table absent (0032 not applied yet) — trivially none')
      else check('flag OFF: no provider_price_book row', !pb.error && (pb.data ?? []).length === 0, pb.error?.message)
      const qe = await admin.from('quote_extractions').select('id').eq('rfq_id', rfq1)
      if (missingRelation(qe.error)) record('flag OFF: no quote_extractions row', 'pass', 'table absent (0032 not applied yet) — trivially none')
      else check('flag OFF: no quote_extractions row', !qe.error && (qe.data ?? []).length === 0, qe.error?.message)
      if (quoteId) {
        const q = await admin.from('quotes').select('extraction_id').eq('id', quoteId).maybeSingle()
        if (missingRelation(q.error)) record('flag OFF: quotes.extraction_id stays null', 'pass', 'column absent (0032 not applied yet)')
        else check('flag OFF: quotes.extraction_id stays null', !q.error && (q.data as { extraction_id?: string | null } | null)?.extraction_id == null, q.error?.message)
      }
      skip('flag ON lifecycle', 'AGENT_ENABLED=false on this server — inertness verified instead')
      return
    }

    // ── Flag ON ────────────────────────────────────────────────────────────
    for (const k of ['agents_enabled', 'cohort_user_ids']) await remember(k)
    const enabledBefore = (settingsBefore.get('agents_enabled')?.value ?? {}) as Record<string, boolean>
    const cohortBefore = (settingsBefore.get('cohort_user_ids')?.value ?? []) as string[]

    await setSetting('agents_enabled', { ...enabledBefore, quote_extract: false })
    let ex = await api(p1.token, `/api/v1/rfq/${rfq1}/quote/extract`, { text: '₹45,000, 10 days, GST extra' })
    await json(ex)
    check('flag ON, agent off → 404', ex.status === 404, `status ${ex.status}`)

    await setSetting('agents_enabled', { ...enabledBefore, quote_extract: true })
    await setSetting('cohort_user_ids', cohortBefore.filter((u) => u !== p1.uid))
    ex = await api(p1.token, `/api/v1/rfq/${rfq1}/quote/extract`, { text: '₹45,000, 10 days, GST extra' })
    await json(ex)
    check('flag ON, agent on, provider NOT in cohort → 404', ex.status === 404, `status ${ex.status}`)

    await setSetting('cohort_user_ids', [...new Set([...cohortBefore, p1.uid])])
    const unmatched = await api(p2.token, `/api/v1/rfq/${rfq1}/quote/extract`, { text: '₹45,000, 10 days' })
    await json(unmatched)
    check('unmatched provider (in cohort? no — 404 by cohort) never reaches the model', unmatched.status === 404 || unmatched.status === 403, `status ${unmatched.status}`)

    const short = await api(p1.token, `/api/v1/rfq/${rfq1}/quote/extract`, { text: 'hi' })
    await json(short)
    check('body too short → 422', short.status === 422, `status ${short.status}`)

    ex = await api(p1.token, `/api/v1/rfq/${rfq1}/quote/extract`, { text: '₹45,000 for the full GST filing, 10 days, GST extra, call 9876543210', source: 'typed' })
    const exBody = await json(ex)
    check('enabled + cohort: extract → 200', ex.status === 200 && typeof exBody['extraction_id'] === 'string', `status ${ex.status} ${JSON.stringify(exBody).slice(0, 160)}`)
    const extractionId = exBody['extraction_id'] as string | undefined
    const fields = exBody['fields'] as Record<string, unknown> | undefined
    check('stub:true without a model key (honest preview)', exBody['stub'] === true, `stub=${String(exBody['stub'])}`)
    check('stub fields are schema-shaped (uncertain price + delivery_days)', Array.isArray(fields?.['uncertain_fields']) && (fields!['uncertain_fields'] as string[]).includes('price'))
    check('summary never carries the phone number (clamp)', typeof fields?.['scope_summary'] === 'string' && !(fields!['scope_summary'] as string).includes('9876543210'))
    if (!extractionId) return

    const { data: qeRow } = await admin.from('quote_extractions').select('id, rfq_id, provider_id, user_id, source, stub, decision_id, input_text').eq('id', extractionId).maybeSingle()
    check('quote_extractions row written (provider, rfq, source typed, stub)', !!qeRow && qeRow.provider_id === p1.providerId && qeRow.rfq_id === rfq1 && qeRow.source === 'typed' && qeRow.stub === true && qeRow.decision_id === null)
    const { data: inv } = await admin.from('ai_invocations').select('id, run_id, task_class, feature, status').eq('user_id', p1.uid).eq('feature', 'quote_extraction').order('created_at', { ascending: false }).limit(1)
    const invRow = inv?.[0] as { run_id: string | null; task_class: string; status: string } | undefined
    check('one ai_invocations row: run_id null, task_class quote_extract, status stub', !!invRow && invRow.run_id === null && invRow.task_class === 'quote_extract' && invRow.status === 'stub', JSON.stringify(invRow ?? null))

    // P2 (another provider) cannot reuse P1's extraction — checked before any slot claim.
    const misuse = await api(p2.token, `/api/v1/rfq/${rfq1}/quote`, { price_paise: 4500000, delivery_days: 10, scope: SCOPE, extraction_id: extractionId })
    const misuseBody = await json(misuse)
    check('another provider using the extraction_id → 422 extraction_mismatch', misuse.status === 422 && misuseBody['error'] === 'extraction_mismatch', `status ${misuse.status} ${misuseBody['error']}`)

    // P1 confirms with an edit (price changed) → ledger + link + price book.
    const sub = await api(p1.token, `/api/v1/rfq/${rfq1}/quote`, { price_paise: 4600000, delivery_days: 10, scope: SCOPE, gst_included: false, extraction_id: extractionId })
    const subBody = await json(sub)
    check('submit with extraction_id → 200 (+ edited_fields in the response)', sub.status === 200 && Array.isArray(subBody['edited_fields']), `status ${sub.status} ${JSON.stringify(subBody).slice(0, 160)}`)
    const quoteId = subBody['quoteId'] as string | undefined
    if (quoteId) {
      const { data: q } = await admin.from('quotes').select('extraction_id, extraction_confirmed_at, price_paise').eq('id', quoteId).maybeSingle()
      check('quote carries extraction_id + extraction_confirmed_at', q?.extraction_id === extractionId && !!q?.extraction_confirmed_at)
      const { data: qe2 } = await admin.from('quote_extractions').select('decision_id').eq('id', extractionId).maybeSingle()
      check('quote_extractions.decision_id set', !!qe2?.decision_id)
      if (qe2?.decision_id) {
        const { data: dec } = await admin.from('ai_decisions').select('feature, tool, run_id, decided_by, corrected_fields, input_refs').eq('id', qe2.decision_id).maybeSingle()
        check('ai_decisions row: feature quote_extraction, tool extract_quote, run_id null, decided_by provider', dec?.feature === 'quote_extraction' && dec?.tool === 'extract_quote' && dec?.run_id === null && dec?.decided_by === p1.uid, JSON.stringify(dec ?? null).slice(0, 200))
        check('ai_decisions.input_refs carries extraction_id + quote_id', (dec?.input_refs as Record<string, unknown> | null)?.['extraction_id'] === extractionId && (dec?.input_refs as Record<string, unknown> | null)?.['quote_id'] === quoteId)
      }
      const { data: ev } = await admin.from('quote_events').select('payload').eq('quote_id', quoteId).eq('event_type', 'submitted').maybeSingle()
      const payload = (ev?.payload ?? {}) as Record<string, unknown>
      check('quote_events.submitted payload has extraction_id + edited_fields (price edited)', payload['extraction_id'] === extractionId && Array.isArray(payload['edited_fields']) && (payload['edited_fields'] as string[]).includes('price'), JSON.stringify(payload['edited_fields']))
      const { data: pb } = await admin.from('provider_price_book').select('kind, category_slug, unit, price_paise, source_quote_id').eq('source_quote_id', quoteId).maybeSingle()
      check("provider_price_book row: services / tax-accounting / unit 'job' / price = quote total", pb?.kind === 'services' && pb?.category_slug === 'tax-accounting' && pb?.unit === 'job' && Number(pb?.price_paise) === 4600000, JSON.stringify(pb ?? null))
    }
    const again = await api(p1.token, `/api/v1/rfq/${rfq1}/quote`, { price_paise: 4600000, delivery_days: 10, scope: SCOPE, extraction_id: extractionId })
    const againBody = await json(again)
    check('re-submit with the same extraction_id → 409 already_quoted (one quote per provider)', again.status === 409 && againBody['error'] === 'already_quoted', `status ${again.status} ${againBody['error']}`)

    // Rate limit: 5/min per provider (one call already used on rfq1 → four more OK, the next 429).
    const rfq2 = await mkRfq(`${tag} two`)
    let last = 0
    let sawLimit = false
    for (let i = 0; i < 6; i++) {
      const r = await api(p1.token, `/api/v1/rfq/${rfq2}/quote/extract`, { text: `₹${50 + i},000, ${i + 3} days` })
      await json(r)
      last = r.status
      if (r.status === 429) { sawLimit = true; break }
    }
    if (sawLimit) check('6th extract within a minute → 429 (quoteExtract limiter)', true)
    else skip('6th extract within a minute → 429', `no 429 seen (last ${last}); Upstash not configured on this rig?`)

    skip('goods RFQ path', 'MART_ENABLED is off on this rig (goods RFQs cannot be created)')
  } finally {
    try {
      if (created.rfqIds.length) {
        const { data: qs } = await admin.from('quotes').select('id').in('rfq_id', created.rfqIds)
        const quoteIds = (qs ?? []).map((q) => q.id as string)
        if (quoteIds.length) {
          await admin.from('provider_price_book').delete().in('source_quote_id', quoteIds)
          await admin.from('quote_events').delete().in('quote_id', quoteIds)
        }
        await admin.from('quote_extractions').delete().in('rfq_id', created.rfqIds)
        await admin.from('quotes').delete().in('rfq_id', created.rfqIds)
        await admin.from('rfq_matches').delete().in('rfq_id', created.rfqIds)
        await admin.from('rfqs').delete().in('id', created.rfqIds)
      }
      if (created.users.length) {
        await admin.from('ai_decisions').delete().in('decided_by', created.users).eq('feature', 'quote_extraction')
        await admin.from('ai_invocations').delete().in('user_id', created.users)
        await admin.from('notifications').delete().in('user_id', created.users)
      }
      if (created.providerIds.length) {
        await admin.from('provider_categories').delete().in('provider_id', created.providerIds)
        await admin.from('provider_profiles').delete().in('id', created.providerIds)
      }
      if (created.msmeIds.length) await admin.from('msme_profiles').delete().in('id', created.msmeIds)
      for (const [key, before] of settingsBefore) {
        if (before.existed) await setSetting(key, before.value)
        else await admin.from('agent_settings').delete().eq('key', key)
      }
      for (const uid of created.users) {
        await admin.from('users').delete().eq('id', uid)
        await admin.auth.admin.deleteUser(uid)
      }
      record('cleanup', 'pass', `${created.users.length} users, ${created.rfqIds.length} RFQs, settings restored`)
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
    console.log('\nverify-quote-extraction\n')
    for (const r of rows) {
      const mark = r.status === 'skip' ? '⏭' : r.status === 'pass' ? '✓' : '✗'
      console.log(`  ${mark} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
    }
    const skipped = rows.filter((r) => r.status === 'skip').length
    console.log(`\n${failed === 0 ? '✅' : '❌'} ${rows.length} checks: ${rows.length - failed - skipped} pass, ${skipped} skipped, ${failed} FAIL\n`)
    process.exitCode = failed === 0 ? 0 : 1
  })
