/**
 * verify-trust — S0.4 trust mechanics kill-test (verify-* convention).
 *
 * Proves, against a running server on the prod DB:
 *   1. quote cap: with agent_settings.rfq_max_quotes set, a NEW RFQ carries that
 *      cap; with the key unset, it carries the legacy 7 (inertness).
 *   2. decline route: buyer -> 403; unmatched provider -> 403; bad reason -> 422;
 *      matched provider -> 200; repeat -> already; inbox shows declined and
 *      the provider can no longer quote.
 *   3. quote window: a match backdated past quote_window_hours is auto-declined
 *      by the rfq-expire cron (CRON_SECRET) with reason window_lapsed and the
 *      buyer gets an rfq_providers_unavailable notification; a fresh match is
 *      untouched.
 *   4. Udyam: the dev stub NEVER sets udyam_verified (chip=false); with the
 *      server started under KYC_FAKE=verified (pass VERIFY_KYC_FAKE=1 here) the
 *      real path sets it (chip=true) ONLY once the enterprise name matches the
 *      buyer's GST-locked name (ADR 028: 422 udyam_name_mismatch before), and a
 *      second account is refused (409 udyam_already_claimed). Skipped, not
 *      failed, when not armed.
 *
 * Zero prod residue: every user/profile/rfq/match/notification/verification row
 * and the settings key touched are removed in finally (settings restored).
 * Run: BASE_URL=<url> [CRON_SECRET=...] [VERIFY_KYC_FAKE=1] pnpm --filter @amclub/web trust:verify
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const URL = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'
const CRON_SECRET = process.env['CRON_SECRET'] ?? ''
const KYC_FAKE_ARMED = process.env['VERIFY_KYC_FAKE'] === '1'
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

let pass = 0, fail = 0, skipped = 0
const check = (n: string, ok: boolean, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }
const skip = (n: string, why: string) => { console.log(`  ⏭ ${n} — ${why}`); skipped++ }
const tag = `trustv_${Date.now()}`
const created = { users: [] as string[], providerIds: [] as string[], msmeIds: [] as string[], rfqIds: [] as string[] }
let settingBefore: { existed: boolean; value: unknown } = { existed: false, value: null }

async function mkUser(label: string, roles: string[]) {
  const email = `${tag}_${label}@killtest.amclub`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(`${label}: ${error.message}`)
  created.users.push(data.user.id)
  await admin.from('users').insert({ id: data.user.id, email, roles })
  const anon = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
  return { uid: data.user.id, token: s.session!.access_token }
}
const api = (token: string, p: string, body?: unknown, method = 'POST') =>
  fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
const json = async (r: Response) => r.json().catch(() => ({}))

async function setCap(value: number | null) {
  if (value === null) { await admin.from('agent_settings').delete().eq('key', 'rfq_max_quotes'); return }
  await admin.from('agent_settings').upsert({ key: 'rfq_max_quotes', value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
}

async function main() {
  console.log(`\nverify-trust → ${BASE}\n`)
  try {
    const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
    const categoryId = cat!.id

    // Remember + isolate the cap setting.
    const { data: sb } = await admin.from('agent_settings').select('value').eq('key', 'rfq_max_quotes').maybeSingle()
    settingBefore = { existed: !!sb, value: sb?.value ?? null }

    // Buyer (KA) + two providers: P1 matched (KA, tax), P2 unmatched (MH).
    const buyer = await mkUser('buyer', ['msme'])
    const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'Trust Buyer Co', state: 'KA', sector: 'services' }).select('id').single()
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

    // ── 1. quote cap ──────────────────────────────────────────────────────────
    await setCap(4)
    let r = await api(buyer.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title: `${tag} cap four`, details: { need: 'gst filing' } })
    let d = await json(r)
    check('RFQ created with cap set', r.status === 200 && !!d.rfqId, `status ${r.status}`)
    if (d.rfqId) created.rfqIds.push(d.rfqId)
    const { data: rfqA } = await admin.from('rfqs').select('max_quotes').eq('id', d.rfqId).single()
    check('cap enforced at configured value (4)', rfqA?.max_quotes === 4, `max_quotes=${rfqA?.max_quotes}`)

    await setCap(null)
    r = await api(buyer.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title: `${tag} cap legacy`, details: { need: 'gst filing' } })
    d = await json(r)
    if (d.rfqId) created.rfqIds.push(d.rfqId)
    const { data: rfqB } = await admin.from('rfqs').select('max_quotes').eq('id', d.rfqId).single()
    check('unset cap falls back to legacy 7 (inert)', rfqB?.max_quotes === 7, `max_quotes=${rfqB?.max_quotes}`)
    const rfqId = d.rfqId as string

    // ── 2. decline route ──────────────────────────────────────────────────────
    const { data: m1 } = await admin.from('rfq_matches').select('provider_id').eq('rfq_id', rfqId).eq('provider_id', p1.providerId).maybeSingle()
    check('P1 (KA, tax) is matched to the RFQ', !!m1)

    r = await api(buyer.token, `/api/v1/rfq/${rfqId}/decline`, { reason: 'capacity' }); await json(r)
    check('buyer cannot decline -> 403', r.status === 403, `status ${r.status}`)
    r = await api(p2.token, `/api/v1/rfq/${rfqId}/decline`, { reason: 'capacity' }); await json(r)
    check('unmatched provider -> 403', r.status === 403, `status ${r.status}`)
    r = await api(p1.token, `/api/v1/rfq/${rfqId}/decline`, { reason: 'busy' }); await json(r)
    check('unknown reason -> 422', r.status === 422, `status ${r.status}`)
    r = await api(p1.token, `/api/v1/rfq/${rfqId}/decline`, { reason: 'not_my_specialty' }); d = await json(r)
    check('matched provider declines -> 200', r.status === 200 && d.ok === true, `status ${r.status}`)
    const { data: m1b } = await admin.from('rfq_matches').select('declined_at, decline_reason').eq('rfq_id', rfqId).eq('provider_id', p1.providerId).single()
    check('rfq_matches carries declined_at + reason', !!m1b?.declined_at && m1b?.decline_reason === 'not_my_specialty')
    r = await api(p1.token, `/api/v1/rfq/${rfqId}/decline`, { reason: 'capacity' }); d = await json(r)
    check('repeat decline is idempotent (already)', r.status === 200 && d.already === true)
    r = await api(p1.token, '/api/v1/rfq/matched', undefined, 'GET'); d = await json(r)
    const mine = (d.rfqs ?? []).find((x: { rfqId: string }) => x.rfqId === rfqId)
    check('inbox marks the RFQ declined', mine?.declined === true)
    r = await api(p1.token, `/api/v1/rfq/${rfqId}/quote`, { rfq_id: rfqId, price_paise: 100000, delivery_days: 3, scope: 'A perfectly reasonable scope of twenty chars' }); await json(r)
    check('declined provider can no longer quote', r.status >= 400, `status ${r.status}`)

    // ── 3. quote window via cron ──────────────────────────────────────────────
    if (process.env['SKIP_CRON'] === '1') {
      skip('window lapse via cron', 'SKIP_CRON=1 (never run the sweep against prod from a dev box; the sweep is also OFF until quote_window_hours is set)')
    } else if (!CRON_SECRET && process.env['NODE_ENV'] === 'production') {
      skip('window lapse via cron', 'CRON_SECRET not set')
    } else {
      // Fresh RFQ: P1 matched again (new rfq) -> backdate its match 49h; make a
      // second match that is fresh by re-notifying P1 on yet another RFQ.
      r = await api(buyer.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title: `${tag} window`, details: { need: 'audit' } }); d = await json(r)
      const rfqW = d.rfqId as string; created.rfqIds.push(rfqW)
      await admin.from('rfq_matches').update({ notified_at: new Date(Date.now() - 49 * 3600 * 1000).toISOString() }).eq('rfq_id', rfqW).eq('provider_id', p1.providerId)
      r = await api(buyer.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title: `${tag} fresh`, details: { need: 'audit' } }); d = await json(r)
      const rfqF = d.rfqId as string; created.rfqIds.push(rfqF)

      const cr = await fetch(`${BASE}/api/v1/cron/rfq-expire`, { headers: CRON_SECRET ? { Authorization: `Bearer ${CRON_SECRET}` } : {} })
      const cd = await json(cr)
      check('cron rfq-expire ran', cr.status === 200, `status ${cr.status} ${JSON.stringify(cd).slice(0, 80)}`)
      const { data: lapsed } = await admin.from('rfq_matches').select('declined_at, decline_reason').eq('rfq_id', rfqW).eq('provider_id', p1.providerId).single()
      check('49h-old silent match auto-declined (window_lapsed)', !!lapsed?.declined_at && lapsed?.decline_reason === 'window_lapsed')
      const { data: fresh } = await admin.from('rfq_matches').select('declined_at').eq('rfq_id', rfqF).eq('provider_id', p1.providerId).single()
      check('fresh match untouched', !fresh?.declined_at)
      const { data: notif } = await admin.from('notifications').select('id, body').eq('user_id', buyer.uid).eq('kind', 'rfq_providers_unavailable').limit(5)
      check('buyer notified "N of M could not take this up"', (notif ?? []).length >= 1)
    }

    // ── 4. Udyam ──────────────────────────────────────────────────────────────
    // A number of our own per run: since ADR 028 one account holds a Udyam number.
    const udyam = `UDYAM-KA-03-${String(Date.now()).slice(-7)}`
    if (KYC_FAKE_ARMED) {
      // ADR 028 — the fake vendor answers "Fake Verified Enterprise". With no GST-locked name on file that is not ours.
      r = await api(buyer.token, '/api/v1/kyc/verify-udyam', { udyam_number: udyam, target: 'msme' }); d = await json(r)
      const { data: mm } = await admin.from('udyam_verifications').select('outcome').eq('user_id', buyer.uid).eq('outcome', 'name_mismatch')
      check('KYC_FAKE, no GST-locked name -> 422 udyam_name_mismatch, recorded for review', r.status === 422 && d.error === 'udyam_name_mismatch' && (mm ?? []).length === 1, `status ${r.status} ${d.error}`)
      // Lock the buyer's GST name to the enterprise's (as a real verify-gstin would) and retry.
      const gstin = '29AAAAA0000A1Z9'
      await admin.from('msme_profiles').update({ gstin }).eq('id', msme!.id)
      await admin.from('gstin_verifications').insert({ user_id: buyer.uid, gstin, verified: true, stub: false, provider: 'surepass', result: { legalName: 'FAKE VERIFIED ENTERPRISE PRIVATE LIMITED', tradeName: null } })
    }
    r = await api(buyer.token, '/api/v1/kyc/verify-udyam', { udyam_number: udyam, target: 'msme' }); d = await json(r)
    const { data: msmeRow } = await admin.from('msme_profiles').select('udyam_verified').eq('id', msme!.id).single()
    if (KYC_FAKE_ARMED) {
      check('KYC_FAKE real path, GST-locked name matches -> chip set', r.status === 200 && d.chip === true && d.basis === 'name' && msmeRow?.udyam_verified === true, `status ${r.status} chip=${d.chip}`)
      // A second account with the same GST-locked name cannot take the number.
      const buyer2 = await mkUser('buyer2', ['msme'])
      const { data: msme2 } = await admin.from('msme_profiles').insert({ user_id: buyer2.uid, business_name: 'Trust Buyer Two', state: 'KA', sector: 'services', gstin: '29AAAAA0000A1Z9' }).select('id').single()
      created.msmeIds.push(msme2!.id)
      await admin.from('gstin_verifications').insert({ user_id: buyer2.uid, gstin: '29AAAAA0000A1Z9', verified: true, stub: false, provider: 'surepass', result: { legalName: 'FAKE VERIFIED ENTERPRISE PRIVATE LIMITED' } })
      r = await api(buyer2.token, '/api/v1/kyc/verify-udyam', { udyam_number: udyam, target: 'msme' }); d = await json(r)
      const { data: m2 } = await admin.from('msme_profiles').select('udyam_verified').eq('id', msme2!.id).single()
      check('second account -> 409 udyam_already_claimed, no chip', r.status === 409 && d.error === 'udyam_already_claimed' && m2?.udyam_verified === false, `status ${r.status} ${d.error}`)
      // The holder re-verifying keeps the claim (a born-released repeat row).
      r = await api(buyer.token, '/api/v1/kyc/verify-udyam', { udyam_number: udyam, target: 'msme' }); d = await json(r)
      const { data: claims } = await admin.from('udyam_verifications').select('user_id').ilike('udyam_number', udyam).eq('outcome', 'verified').is('released_at', null)
      check('holder repeat -> 200, still exactly one active claim (the holder)', r.status === 200 && (claims ?? []).length === 1 && claims?.[0]?.user_id === buyer.uid, `status ${r.status} claims=${(claims ?? []).length}`)
    } else {
      check('stub Udyam answers verified but NEVER sets the boolean', r.status === 200 && d.stub === true && d.chip === false && msmeRow?.udyam_verified === false, `status ${r.status} stub=${d.stub} chip=${d.chip}`)
      skip('real-path chip set', 'start the server with KYC_FAKE=verified and pass VERIFY_KYC_FAKE=1')
    }
    const { data: uv } = await admin.from('udyam_verifications').select('id, stub, verified').eq('user_id', buyer.uid)
    check('every attempt recorded in udyam_verifications', (uv ?? []).length >= 1)
    r = await api(buyer.token, '/api/v1/kyc/verify-udyam', { udyam_number: 'NOT-A-UDYAM' }); await json(r)
    check('malformed Udyam number -> 422', r.status === 422, `status ${r.status}`)
  } finally {
    // ── cleanup — zero residue ────────────────────────────────────────────────
    if (settingBefore.existed) await admin.from('agent_settings').upsert({ key: 'rfq_max_quotes', value: settingBefore.value as never }, { onConflict: 'key' })
    else await admin.from('agent_settings').delete().eq('key', 'rfq_max_quotes')
    for (const id of created.rfqIds) await admin.from('rfqs').delete().eq('id', id)
    for (const uid of created.users) {
      await admin.from('notifications').delete().eq('user_id', uid)
      await admin.from('udyam_verifications').delete().eq('user_id', uid)
      await admin.from('gstin_verifications').delete().eq('user_id', uid)
    }
    for (const id of created.providerIds) { await admin.from('provider_categories').delete().eq('provider_id', id); await admin.from('provider_profiles').delete().eq('id', id) }
    for (const id of created.msmeIds) await admin.from('msme_profiles').delete().eq('id', id)
    for (const uid of created.users) { await admin.from('users').delete().eq('id', uid); await admin.auth.admin.deleteUser(uid).catch(() => null) }
    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass + fail + skipped} checks: ${pass} pass, ${skipped} skipped, ${fail} FAIL (residue cleaned)\n`)
    process.exitCode = fail === 0 ? 0 : 1
  }
}

main().catch((e) => { console.error(e); process.exitCode = 2 })
