/**
 * verify-voice-v2 — S1.8 (voice RFQ v2: ONE clarifying question + document / drawing intake → prefill)
 * (verify-* convention; rig, service role; modelled on verify-rfq-quality / verify-dispute-triage).
 *
 * OFFLINE: parseStepSummary(cad1.step) returns the pinned counts; parseDxfSummary(plate.dxf) layers + counts;
 *   the needsClarification table; the masking clamp; rfq_parse@v1 == the Phase 8b constant (lead + rules);
 *   eval:golden invoked (SKIPPED without an LLM key → recorded as a skip, exit 0 required).
 * HTTP flag-OFF (BASE_URL, AGENT_ENABLED=false server): voice-parse reply has EXACTLY the Phase 8b key set and no
 *   `clarify`; document-extract → 404; attachments upload (spine) → bucket reference; the buyer's and a matched
 *   provider's detail reads carry a working signed URL, a stranger gets 404; POST /rfq with a foreign
 *   intake_extraction_id → 422 without an RFQ; bad type → 422; oversize → 413.
 * Flag-ON (AGENT_ENABLED=true server, VOICE_STUB_TRANSCRIPT set to a vague sentence, stub vendors): round one →
 *   `clarify` once (gap category, extraction row, audio null); round two typed + audio → merged parse, NEVER another
 *   `clarify`; clarify_tts_enabled → tts invocation row (stub; real audio = recorded skip); image → document result
 *   (stub, uncertain), text PDF → masked facts, scanned PDF → 422 + attachment stored, STEP → pinned drawing with
 *   model NULL and no invocation, DXF → layers; create with 2 ids + voice_meta.clarify → ONE ai_decisions row
 *   (feature rfq_intake) and linked rows; reuse → 422; 5 ids → 422; 429 (Upstash only) and goods mode (MART) skipped.
 * Zero residue (rows + rfq-attachments objects), settings restored.
 *
 * Run: BASE_URL=http://localhost:3100 pnpm --filter @amclub/web voice:verify:v2
 */
import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
import { randomUUID } from 'crypto'
import { spawnSync } from 'child_process'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  clampDocumentExtract,
  intakeResultSchema,
  maskIdentityNumbers,
  needsClarification,
  parseDxfSummary,
  parseStepSummary,
  voiceParseResponseSchema,
  type RfqTemplate,
  type VoiceParse,
} from '@amclub/shared'
import { getPrompt, loadDefaultPrompts } from '@amclub/agent-core'
import { PHASE8B_LEAD, PHASE8B_RULES } from '../../../packages/agent-core/src/prompts/rfq_parse/phase8b.fixture'

const BASE = (process.env['BASE_URL'] || '').replace(/\/$/, '')
const SUPA_URL = process.env['NEXT_PUBLIC_SUPABASE_URL'] || ''
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] || ''
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY'] || ''
const BUCKET = 'rfq-attachments'
const NIL = '00000000-0000-0000-0000-000000000000'

// The pinned STEP fixture (packages/shared intake.test.ts pins the same numbers).
const CAD1 = { solids: 1, faces: 51, cylindrical_surfaces: 17, planes: 34, edges: 149, points: 300, hole_estimate: 9, bbox_mm: [60.5, 20.1, 506.3], units: 'mm', product_name: 'Untitled', ap: 'STEP AP214' }

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

// ── fixtures ─────────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '../../..')
const STEP_PATH = path.resolve(__dirname, '../tests/fixtures/drawings/cad1.step')
const DXF_PATH = path.join(ROOT, 'packages/shared/src/__tests__/fixtures/plate.dxf')
const PNG_PATH = path.join(ROOT, 'packages/agent-core/golden/documents/gst_notice_1.png')

function wavSilence(ms = 500): Buffer {
  const rate = 8000
  const samples = Math.round((rate * ms) / 1000)
  const data = Buffer.alloc(samples * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}
/** A minimal valid PDF: one page, Helvetica, one line of text (or none for the "scanned" case). Correct xref. */
function pdf(text: string | null): Buffer {
  const content = text ? `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, (c) => '\\' + c)}) Tj ET` : ''
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Root 1 0 R /Size ${objs.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

// ── OFFLINE ──────────────────────────────────────────────────────────────────
function offline() {
  const step = parseStepSummary(fs.readFileSync(STEP_PATH, 'utf8'))
  check('STEP: cad1.step → pinned counts, units, bbox, AP', step.counts['solids'] === CAD1.solids && step.counts['faces'] === CAD1.faces && step.counts['cylindrical_surfaces'] === CAD1.cylindrical_surfaces && step.counts['planes'] === CAD1.planes && step.counts['edges'] === CAD1.edges && step.hole_estimate === CAD1.hole_estimate && step.units === CAD1.units && JSON.stringify(step.bbox_mm) === JSON.stringify(CAD1.bbox_mm) && step.spec_rows.find((r) => r.k === 'Source')?.v === CAD1.ap, JSON.stringify({ counts: step.counts, holes: step.hole_estimate, bbox: step.bbox_mm }))
  const dxf = parseDxfSummary(fs.readFileSync(DXF_PATH, 'utf8'))
  check('DXF: plate.dxf → mm, 120 × 80, layers OUTLINE/HOLES, 3 circles', dxf.units === 'mm' && dxf.bbox_mm?.[0] === 120 && dxf.bbox_mm?.[1] === 80 && dxf.layers.join(',') === 'OUTLINE,HOLES' && dxf.counts['CIRCLE'] === 3 && dxf.hole_estimate === 3, JSON.stringify(dxf.counts))
  const tpl: RfqTemplate = { fields: [{ name: 'business_type', type: 'select', label_en: 'Business type', label_hi: 'x', required: true, options: ['Proprietorship', 'Private Limited'] }] }
  const p = (o: Partial<VoiceParse>): VoiceParse => ({ category_slug: 'tax-accounting', specialization: null, state: 'AP', description_english: 'File the monthly GST returns for my private limited garment unit in Guntur, pending since April.', original_language: 'te-IN', uncertain: false, ...o })
  check('needsClarification: category > required field > scope > state > null', needsClarification(p({ uncertain: true, category_slug: null }), tpl)?.gap === 'category' && needsClarification(p({ description_english: 'File GST returns for my unit in Guntur since April 2026.' }), tpl)?.gap === 'business_type' && needsClarification(p({ description_english: 'GST filing.' }), null)?.gap === 'scope' && needsClarification(p({ state: null, description_english: 'File the monthly GST returns for my private limited garment unit, pending since April this year.' }), null)?.gap === 'state' && needsClarification(p({}), tpl) === null)
  const clamped = clampDocumentExtract({ doc_type: 'invoice', facts: [{ k: 'GSTIN', v: '36AAACR1234A1Z5', confidence: 'high' }, { k: 'Contact', v: 'call 9876543210', confidence: 'low' }], suggested_category_slug: null, description_english: 'PAN AAACR1234A', uncertain: false })
  check('masking clamp: GSTIN/PAN → last 4, phone stripped', maskIdentityNumbers('36AAACR1234A1Z5') === 'XXXXXXXXXXXA1Z5' && clamped.facts[0]?.v === 'XXXXXXXXXXXA1Z5' && !JSON.stringify(clamped).includes('9876543210') && !clamped.description_english.includes('AAACR1234A'))
  loadDefaultPrompts()
  const v1 = getPrompt('rfq_parse', 'v1')
  const v2 = getPrompt('rfq_parse', 'v2')
  check('rfq_parse@v1 == the Phase 8b constant (lead + rules byte-equal); v2 = v1 + PRIOR ROUND', v1.text.startsWith(PHASE8B_LEAD) && v1.text.endsWith(PHASE8B_RULES) && v2.text.startsWith(v1.text) && v2.text.includes('PRIOR ROUND'))
  const r = spawnSync('pnpm', ['--filter', '@amclub/web', 'eval:golden'], { cwd: ROOT, shell: process.platform === 'win32', encoding: 'utf8', timeout: 240_000 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (/SKIPPED/.test(out)) skip('eval:golden (the real parser over tests/ai-golden/cases.json)', `no LLM key here — exit ${r.status} (SKIPPED)`)
  else check('eval:golden green', r.status === 0, out.split('\n').filter((l) => /pass|fail|agreement/i.test(l)).slice(-3).join(' | '))
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function http() {
  if (!BASE || !SUPA_URL || !ANON || !SERVICE) {
    skip('HTTP checks', 'set BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
    return
  }
  console.log(`verify-voice-v2 → ${BASE}`)
  const admin: SupabaseClient = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } })
  const tag = `kt_v2_${Date.now().toString(36)}`
  const created = { users: [] as string[], msmeIds: [] as string[], providerIds: [] as string[], rfqIds: [] as string[] }
  const settingsBefore = new Map<string, { existed: boolean; value: unknown }>()
  async function remember(key: string) {
    const { data } = await admin.from('agent_settings').select('value').eq('key', key).maybeSingle()
    settingsBefore.set(key, { existed: !!data, value: data?.value })
  }
  async function setSetting(key: string, value: unknown) {
    await admin.from('agent_settings').upsert({ key, value }, { onConflict: 'key' })
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
  const api = (token: string, p: string, body?: unknown, method = 'POST') =>
    fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const multipart = (token: string, p: string, fields: Record<string, string>, file?: { name: string; type: string; bytes: Buffer; field?: string }) => {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    if (file) form.append(file.field ?? 'file', new File([new Uint8Array(file.bytes)], file.name, { type: file.type }), file.name)
    return fetch(`${BASE}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
  }
  const listObjects = async (folder: string) => ((await admin.storage.from(BUCKET).list(folder, { limit: 100 })).data ?? []).map((o) => o.name)

  // Is the server dark? The document route 404s before auth when AGENT_ENABLED=false, 401 after it otherwise.
  const probe = await fetch(`${BASE}/api/v1/rfq/document-extract`, { method: 'POST' })
  const flagOn = probe.status !== 404
  // Does the private bucket exist yet? It is created at the gate by packages/db setup-storage.ts (the wa-media
  // precedent); before that every upload 500s "Bucket not found" and the attachment checks are recorded as skips.
  const bucket = await admin.storage.getBucket(BUCKET)
  const bucketReady = !bucket.error && !!bucket.data
  console.log(`  server: AGENT_ENABLED=${flagOn}; bucket ${BUCKET}: ${bucketReady ? `present (public=${bucket.data?.public})` : 'MISSING'}`)
  if (bucketReady) check(`bucket ${BUCKET} is private`, bucket.data?.public === false, `public=${bucket.data?.public}`)
  const NO_BUCKET = `${BUCKET} bucket not created yet — created at the gate with setup-storage.ts`

  try {
    const buyer = await mkUser('buyer', ['msme'])
    const prov = await mkUser('prov', ['provider'])
    const stranger = await mkUser('stranger', ['msme'])
    const { data: cat } = await admin.from('categories').select('id, rfq_template').eq('slug', 'tax-accounting').single()
    const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'V2 Buyer Co', state: 'AP', sector: 'services' }).select('id').single()
    created.msmeIds.push(msme!.id)
    const { data: msme2 } = await admin.from('msme_profiles').insert({ user_id: stranger.uid, business_name: 'V2 Stranger Co', state: 'MH', sector: 'services' }).select('id').single()
    created.msmeIds.push(msme2!.id)
    const { data: pp } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'V2 Prov', display_name: 'V2 Prov', slug: `${tag}-prov`, state: 'AP', status: 'active', capacity_paused: false, languages: ['en'] }).select('id').single()
    created.providerIds.push(pp!.id)
    await admin.from('provider_categories').insert({ provider_id: pp!.id, category_id: cat!.id })
    const folder = msme!.id

    if (!flagOn) {
      // ── flag OFF ─────────────────────────────────────────────────────────
      const vp = await multipart(buyer.token, '/api/v1/rfq/voice-parse', { duration_ms: '3000' }, { name: 'recording.wav', type: 'audio/wav', bytes: wavSilence(), field: 'audio' })
      const vpb = await json(vp)
      check('flag OFF: voice-parse reply has EXACTLY the Phase 8b keys (no clarify)', vp.status === 200 && Object.keys(vpb).sort().join(',') === 'parse,stub,transcript_english,vendor' && voiceParseResponseSchema.safeParse(vpb).success, `status ${vp.status} keys ${Object.keys(vpb).join(',')}`)
      const de = await multipart(buyer.token, '/api/v1/rfq/document-extract', { mode: 'service' }, { name: 'n.png', type: 'image/png', bytes: fs.readFileSync(PNG_PATH) })
      check('flag OFF: POST /api/v1/rfq/document-extract → 404', de.status === 404, `status ${de.status}`)
      const badType = await multipart(buyer.token, '/api/v1/rfq/attachments', {}, { name: 'evil.exe', type: 'application/octet-stream', bytes: Buffer.from('MZ') })
      check('attachments: .exe → 422 file_type_unsupported', badType.status === 422 && (await json(badType))['error'] === 'file_type_unsupported', `status ${badType.status}`)
      const big = await multipart(buyer.token, '/api/v1/rfq/attachments', {}, { name: 'big.png', type: 'image/png', bytes: Buffer.alloc(10 * 1024 * 1024 + 1024, 1) })
      check('attachments: > 10 MB → 413', big.status === 413, `status ${big.status}`)
      let upb: { url?: string; name?: string } = {}
      if (bucketReady) {
        const up = await multipart(buyer.token, '/api/v1/rfq/attachments', {}, { name: 'notice.png', type: 'image/png', bytes: fs.readFileSync(PNG_PATH) })
        upb = (await json(up)) as { url?: string; name?: string }
        check('attachments (spine): PNG → 200, bucket reference, object stored', up.status === 200 && String(upb.url ?? '').startsWith(`${BUCKET}/${folder}/`) && upb.name === 'notice.png' && (await listObjects(folder)).length === 1, `status ${up.status} ${upb.url}`)
        const strangerUp = await multipart(stranger.token, '/api/v1/rfq/attachments', {}, { name: 'x.png', type: 'image/png', bytes: fs.readFileSync(PNG_PATH) })
        check('attachments: another buyer uploads into their OWN folder', strangerUp.status === 200 && String((await json(strangerUp))['url']).startsWith(`${BUCKET}/${msme2!.id}/`))
      } else {
        skip('attachments (spine): PNG → 200, bucket reference, object stored', NO_BUCKET)
        skip('attachments: another buyer uploads into their OWN folder', NO_BUCKET)
      }
      const foreign = await api(buyer.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title: 'GST filing for a garment unit', details: { additional_details: 'File my monthly returns, three months pending, Guntur.' }, attachments: [], intake_extraction_ids: [randomUUID()] })
      const { count: rfqsBefore } = await admin.from('rfqs').select('id', { count: 'exact', head: true }).eq('msme_id', folder)
      check('POST /rfq with a foreign intake id → 422 intake_not_found, no RFQ inserted', foreign.status === 422 && (await json(foreign))['error'] === 'intake_not_found' && (rfqsBefore ?? 0) === 0, `status ${foreign.status}`)
      const create = await api(buyer.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title: 'GST filing for a garment unit', details: { additional_details: 'File my monthly returns, three months pending, Guntur.' }, attachments: upb.url ? [{ url: upb.url, name: upb.name }] : [] })
      const cb = (await json(create)) as { rfqId?: string; matched?: number }
      if (cb.rfqId) created.rfqIds.push(cb.rfqId)
      check(`POST /rfq ${upb.url ? 'with the attachment' : '(no attachment — bucket pending)'} → 200 (spine unchanged)`, create.status === 200 && !!cb.rfqId, `status ${create.status} matched ${cb.matched}`)
      const { data: matches } = await admin.from('rfq_matches').select('provider_id').eq('rfq_id', cb.rfqId ?? NIL)
      check('fan-out matched the kill-test provider (same category + state)', (matches ?? []).some((m) => m.provider_id === pp!.id), `matches ${matches?.length ?? 0}`)
      if (bucketReady && upb.url) {
        const asBuyer = (await json(await api(buyer.token, `/api/v1/rfq/${cb.rfqId}`, undefined, 'GET'))) as { rfq?: { attachments?: { url: string; name: string }[] } }
        const bUrl = asBuyer.rfq?.attachments?.[0]?.url ?? ''
        const bFetch = bUrl ? await fetch(bUrl) : null
        check('buyer detail read: the attachment is a 15-min signed URL that serves the object', bUrl.includes('/object/sign/') && bFetch?.status === 200 && (bFetch.headers.get('content-type') ?? '').includes('image/png'), `${bUrl.slice(0, 60)}… ${bFetch?.status}`)
        if ((matches ?? []).some((m) => m.provider_id === pp!.id)) {
          const asProv = (await json(await api(prov.token, `/api/v1/rfq/${cb.rfqId}`, undefined, 'GET'))) as { rfq?: { attachments?: { url: string }[] } }
          const pUrl = asProv.rfq?.attachments?.[0]?.url ?? ''
          check('matched provider detail read: signed URL too', pUrl.includes('/object/sign/') && (await fetch(pUrl)).status === 200, pUrl.slice(0, 60))
        } else skip('matched provider detail read', 'the provider was not matched')
      } else {
        skip('buyer detail read: signed URL', NO_BUCKET)
        skip('matched provider detail read: signed URL', NO_BUCKET)
      }
      const asStranger = await api(stranger.token, `/api/v1/rfq/${cb.rfqId}`, undefined, 'GET')
      check('stranger detail read: 404 (never reaches the signer)', asStranger.status === 404, `status ${asStranger.status}`)
      skip('flag ON lifecycle', 'server is dark (AGENT_ENABLED=false)')
      return
    }

    // ── flag ON ───────────────────────────────────────────────────────────
    for (const k of ['agents_enabled', 'cohort_user_ids', 'clarify_tts_enabled']) await remember(k)
    const enabledBefore = (settingsBefore.get('agents_enabled')?.value ?? {}) as Record<string, boolean>
    const cohortBefore = (settingsBefore.get('cohort_user_ids')?.value ?? []) as string[]
    await setSetting('agents_enabled', { ...enabledBefore, rfq_clarify: true, document_intake: true })
    await setSetting('cohort_user_ids', [...new Set([...cohortBefore, buyer.uid])])
    await setSetting('clarify_tts_enabled', false)
    const invCount = async (task: string) => ((await admin.from('ai_invocations').select('id').eq('user_id', buyer.uid).eq('task_class', task)).data ?? []).length

    const strangerDe = await multipart(stranger.token, '/api/v1/rfq/document-extract', { mode: 'service' }, { name: 'n.png', type: 'image/png', bytes: fs.readFileSync(PNG_PATH) })
    check('flag ON: a buyer outside the cohort → 404 (indistinguishable from dark)', strangerDe.status === 404, `status ${strangerDe.status}`)

    // C1 — round one: the stub transcript is steered vague (VOICE_STUB_TRANSCRIPT) → uncertain → gap category → clarify.
    const r1 = await multipart(buyer.token, '/api/v1/rfq/voice-parse', { duration_ms: '3000' }, { name: 'recording.wav', type: 'audio/wav', bytes: wavSilence(), field: 'audio' })
    const r1b = (await json(r1)) as { transcript_english?: string; parse?: VoiceParse; clarify?: { question: string; gap: string; locale: string; audio_data_url: string | null; extraction_id: string } }
    const c1 = r1b.clarify
    const { data: cRow } = c1 ? await admin.from('rfq_intake_extractions').select('id, kind, proposed, stub, rfq_id').eq('id', c1.extraction_id).maybeSingle() : { data: null }
    check('round one → ONE clarify (gap category, locale te, no audio), parse uncertain, extraction row kind clarify, invocations rfq_parse + rfq_clarify', r1.status === 200 && !!c1 && c1.gap === 'category' && c1.locale === 'te' && c1.audio_data_url === null && r1b.parse?.uncertain === true && (cRow as { kind?: string } | null)?.kind === 'clarify' && (await invCount('rfq_parse')) === 1 && (await invCount('rfq_clarify')) === 1, `status ${r1.status} clarify ${JSON.stringify(c1).slice(0, 120)}`)
    if (!c1 || !r1b.parse) throw new Error('round one produced no clarify — cannot continue the lifecycle')
    check('the question is in Telugu script, one question mark, no digits', /[ఀ-౿]/.test(c1.question) && (c1.question.match(/\?/g) ?? []).length <= 1 && !/\d{7,}/.test(c1.question), c1.question)

    // C2 — round two, typed answer (no STT): merged parse, NEVER another clarify.
    const prior = { transcript_english: r1b.transcript_english!, parse: r1b.parse, question: { question: c1.question, gap: c1.gap, locale: c1.locale } }
    const answer = 'I need my monthly GST returns filed for my garment shop in Guntur, three months pending.'
    const r2 = await multipart(buyer.token, '/api/v1/rfq/voice-parse', { prior: JSON.stringify({ ...prior, answer_text: answer }), answer_text: answer })
    const r2b = (await json(r2)) as { parse?: VoiceParse; clarify?: unknown; vendor?: { stt: string; parser: string } }
    check('round two (typed): merged parse (category from the answer, state AP), vendor.stt typed, NO clarify key, rfq_parse@v2 invocation', r2.status === 200 && !('clarify' in r2b) && r2b.parse?.category_slug === 'tax-accounting' && r2b.parse?.state === 'AP' && r2b.vendor?.stt === 'typed' && (await invCount('rfq_parse')) === 2, `status ${r2.status} ${JSON.stringify(r2b.parse).slice(0, 120)}`)
    const r3 = await multipart(buyer.token, '/api/v1/rfq/voice-parse', { duration_ms: '2500', prior: JSON.stringify(prior) }, { name: 'answer.wav', type: 'audio/wav', bytes: wavSilence(), field: 'audio' })
    const r3b = (await json(r3)) as { clarify?: unknown; vendor?: { stt: string } }
    check('round two (audio): STT ran, NO clarify key (one round, enforced server-side)', r3.status === 200 && !('clarify' in r3b) && r3b.vendor?.stt === 'stub', `status ${r3.status}`)
    const badPrior = await multipart(buyer.token, '/api/v1/rfq/voice-parse', { prior: '{"nope":1}', answer_text: 'x' })
    check('round two with an invalid prior → 422 prior_invalid', badPrior.status === 422, `status ${badPrior.status}`)

    // C4 — TTS switch on: a text_to_speech invocation row (stub here), audio still null.
    await setSetting('clarify_tts_enabled', true)
    const r4 = await multipart(buyer.token, '/api/v1/rfq/voice-parse', { duration_ms: '3000' }, { name: 'recording.wav', type: 'audio/wav', bytes: wavSilence(), field: 'audio' })
    const r4b = (await json(r4)) as { clarify?: { audio_data_url: string | null; extraction_id: string } }
    check('clarify_tts_enabled → one text_to_speech invocation (stub), audio_data_url null without a key', r4.status === 200 && !!r4b.clarify && r4b.clarify.audio_data_url === null && (await invCount('text_to_speech')) === 1, `status ${r4.status}`)
    skip('clarify audio (a real data:audio URL ≤ 400 KB)', 'needs SARVAM_API_KEY — stub returns null')
    await setSetting('clarify_tts_enabled', false)

    // D — documents (the route stores the file first: without the bucket every call would 500)
    if (!bucketReady) {
      for (const n of ['image → document result', 'text PDF → masked facts', 'scanned PDF → 422 + attachment', 'STEP → pinned drawing (model NULL)', 'DXF → layers', 'goods mode', '6th call → 429', 'create with 2 ids → ONE ai_decisions row + linked rows', 'reuse → 422', '5 ids → 422', "another buyer's id → 422"]) skip(n, NO_BUCKET)
      return
    }
    const docInvBefore = await invCount('document_extract')
    const d1 = await multipart(buyer.token, '/api/v1/rfq/document-extract', { mode: 'service' }, { name: 'gst_notice.png', type: 'image/png', bytes: fs.readFileSync(PNG_PATH) })
    const d1b = await json(d1)
    const d1p = intakeResultSchema.safeParse(d1b)
    const { data: d1row } = d1p.success ? await admin.from('rfq_intake_extractions').select('kind, model, stub').eq('id', d1p.data.extraction_id).maybeSingle() : { data: null }
    check('image → document result (stub: uncertain, no invented facts), row kind document, ONE document_extract invocation (frontier tier, stub)', d1.status === 200 && d1p.success && d1p.data.kind === 'document' && d1p.data.stub === true && d1p.data.result.uncertain === true && d1p.data.attachment.url.startsWith(`${BUCKET}/${folder}/`) && (d1row as { kind?: string } | null)?.kind === 'document' && (await invCount('document_extract')) === docInvBefore + 1 && ((await admin.from('ai_invocations').select('tier, status').eq('user_id', buyer.uid).eq('task_class', 'document_extract')).data ?? []).every((r) => r.tier === 'frontier' && r.status === 'stub'), `status ${d1.status} ${JSON.stringify(d1b).slice(0, 140)}`)
    const d2 = await multipart(buyer.token, '/api/v1/rfq/document-extract', { mode: 'service' }, { name: 'notice.pdf', type: 'application/pdf', bytes: pdf('GST notice under section 61 for GSTIN 36AAACR1234A1Z5 amount Rs. 45,000 due by 30/09/2026') })
    const d2b = await json(d2)
    const d2p = intakeResultSchema.safeParse(d2b)
    const d2s = JSON.stringify(d2b)
    check('text PDF → facts from the text layer (stub), doc_type gst_notice, GSTIN masked to the last 4 in the reply and the row', d2.status === 200 && d2p.success && d2p.data.kind === 'document' && d2p.data.result.doc_type === 'gst_notice' && !d2s.includes('36AAACR1234A1Z5') && d2s.includes('A1Z5') && d2p.data.result.facts.some((f) => f.k === 'Section'), `status ${d2.status} ${d2s.slice(0, 160)}`)
    if (d2p.success) {
      const { data: row } = await admin.from('rfq_intake_extractions').select('proposed, input_refs').eq('id', d2p.data.extraction_id).maybeSingle()
      check('the stored row carries the masked facts and refs only (no document text)', !JSON.stringify(row).includes('36AAACR1234A1Z5') && !JSON.stringify(row).includes('due by 30/09/2026'))
    }
    const d3 = await multipart(buyer.token, '/api/v1/rfq/document-extract', { mode: 'service' }, { name: 'scan.pdf', type: 'application/pdf', bytes: pdf(null) })
    const d3b = (await json(d3)) as { error?: string; attachment?: { url: string } }
    check('scanned PDF → 422 pdf_no_text, the attachment still stored', d3.status === 422 && d3b.error === 'pdf_no_text' && !!d3b.attachment?.url && (await listObjects(folder)).length === 3, `status ${d3.status} ${JSON.stringify(d3b).slice(0, 120)}`)
    const docInvAfter = await invCount('document_extract')
    const d4 = await multipart(buyer.token, '/api/v1/rfq/document-extract', { mode: 'service' }, { name: 'cad1.step', type: 'application/octet-stream', bytes: fs.readFileSync(STEP_PATH) })
    const d4b = await json(d4)
    const d4p = intakeResultSchema.safeParse(d4b)
    const { data: d4row } = d4p.success ? await admin.from('rfq_intake_extractions').select('kind, model, stub').eq('id', d4p.data.extraction_id).maybeSingle() : { data: null }
    check('STEP → drawing result with the pinned counts, row model NULL, NO model invocation', d4.status === 200 && d4p.success && d4p.data.kind === 'drawing' && d4p.data.result.counts['faces'] === CAD1.faces && d4p.data.result.counts['cylindrical_surfaces'] === CAD1.cylindrical_surfaces && d4p.data.result.hole_estimate === CAD1.hole_estimate && (d4row as { model?: string | null } | null)?.model === null && (await invCount('document_extract')) === docInvAfter, `status ${d4.status} ${JSON.stringify(d4b).slice(0, 120)}`)
    const d5 = await multipart(buyer.token, '/api/v1/rfq/document-extract', { mode: 'service' }, { name: 'plate.dxf', type: 'image/vnd.dxf', bytes: fs.readFileSync(DXF_PATH) })
    const d5p = intakeResultSchema.safeParse(await json(d5))
    check('DXF → drawing result with layers OUTLINE/HOLES', d5.status === 200 && d5p.success && d5p.data.kind === 'drawing' && d5p.data.result.layers.join(',') === 'OUTLINE,HOLES', `status ${d5.status}`)
    const goods = await multipart(buyer.token, '/api/v1/rfq/document-extract', { mode: 'goods' }, { name: 'n.png', type: 'image/png', bytes: fs.readFileSync(PNG_PATH) })
    if (goods.status === 404) skip('goods mode (spec rows)', 'MART_ENABLED is off on this server → 404 by design')
    else check('goods mode → document result', goods.status === 200, `status ${goods.status}`)
    if (process.env['UPSTASH_REDIS_REST_URL']) {
      let last = 200
      for (let i = 0; i < 6; i++) last = (await multipart(buyer.token, '/api/v1/rfq/document-extract', { mode: 'service' }, { name: 'plate.dxf', type: 'image/vnd.dxf', bytes: fs.readFileSync(DXF_PATH) })).status
      check('6th document call in a minute → 429', last === 429, `last ${last}`)
    } else skip('6th document call in a minute → 429', 'rate limiting is disabled without Upstash (UPSTASH_REDIS_REST_URL unset)')

    // E — the Create tap confirms: 2 ids + voice_meta.clarify → ONE ai_decisions row, rows linked; reuse → 422; 5 ids → 422.
    if (!d2p.success || !d4p.success) throw new Error('document results missing — cannot test the create link')
    const { count: decBefore } = await admin.from('ai_decisions').select('id', { count: 'exact', head: true }).eq('decided_by', buyer.uid).eq('feature', 'rfq_intake')
    const voiceMeta = { transcript_english: r1b.transcript_english, parse: r2b.parse, duration_ms: 3000, edited_fields: [], vendor: { stt: 'typed', parser: 'stub' }, clarify: { question: c1.question, gap: c1.gap, answer_transcript: answer, answered_by: 'text' } }
    const create = await api(buyer.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title: 'GST returns for a garment shop in Guntur', details: { additional_details: answer, document_facts: 'Section: 61 · Amount: ₹45,000' }, attachments: [d2p.data.attachment, d4p.data.attachment], voice_meta: voiceMeta, intake_extraction_ids: [d2p.data.extraction_id, d4p.data.extraction_id] })
    const cb = (await json(create)) as { rfqId?: string }
    if (cb.rfqId) created.rfqIds.push(cb.rfqId)
    const { data: decs } = await admin.from('ai_decisions').select('id, feature, tool, run_id, input_refs, proposed, final').eq('decided_by', buyer.uid).eq('feature', 'rfq_intake')
    const dec = (decs ?? [])[0] as { id: string; tool: string; run_id: string | null; input_refs: { rfq_id?: string; extraction_ids?: string[] }; proposed: Record<string, unknown>; final: { clarify?: unknown } } | undefined
    const { data: linked } = await admin.from('rfq_intake_extractions').select('id, rfq_id, decision_id').in('id', [d2p.data.extraction_id, d4p.data.extraction_id])
    check('create with 2 ids + voice_meta.clarify → 200, ONE ai_decisions row (feature rfq_intake, tool extract_document, run_id null, both ids, clarify in final), rows linked (rfq_id + decision_id)', create.status === 200 && !!cb.rfqId && (decs ?? []).length === (decBefore ?? 0) + 1 && dec?.tool === 'extract_document' && dec.run_id === null && dec.input_refs.rfq_id === cb.rfqId && (dec.input_refs.extraction_ids ?? []).length === 2 && Object.keys(dec.proposed).length === 2 && !!dec.final.clarify && (linked ?? []).every((r) => r.rfq_id === cb.rfqId && r.decision_id === dec.id), `status ${create.status} ${JSON.stringify(cb)}`)
    const { data: rfqRow } = await admin.from('rfqs').select('voice_meta, attachments').eq('id', cb.rfqId!).maybeSingle()
    check('rfqs.voice_meta carries the clarify record; attachments stored as bucket references', (rfqRow as { voice_meta?: { clarify?: { answered_by?: string } }; attachments?: { url: string }[] } | null)?.voice_meta?.clarify?.answered_by === 'text' && ((rfqRow as { attachments?: { url: string }[] } | null)?.attachments ?? []).every((a) => a.url.startsWith(`${BUCKET}/`)))
    const asBuyer = (await json(await api(buyer.token, `/api/v1/rfq/${cb.rfqId}`, undefined, 'GET'))) as { rfq?: { attachments?: { url: string }[] } }
    check('buyer detail read: both attachments signed', (asBuyer.rfq?.attachments ?? []).length === 2 && (asBuyer.rfq?.attachments ?? []).every((a) => a.url.includes('/object/sign/')))
    const reuse = await api(buyer.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title: 'GST returns for a garment shop again', details: { additional_details: answer }, attachments: [], intake_extraction_ids: [d2p.data.extraction_id] })
    check('reuse of a linked id → 422 intake_already_linked', reuse.status === 422 && (await json(reuse))['error'] === 'intake_already_linked', `status ${reuse.status}`)
    const five = await api(buyer.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title: 'GST returns for a garment shop again', details: {}, attachments: [], intake_extraction_ids: Array.from({ length: 5 }, () => randomUUID()) })
    check('5 ids → 422 (schema max 4)', five.status === 422, `status ${five.status}`)
    const notMine = await api(stranger.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title: 'GST returns for a garment shop again', details: {}, attachments: [], intake_extraction_ids: [d5p.success ? d5p.data.extraction_id : NIL] })
    check("another buyer's unlinked id → 422 intake_not_owned", notMine.status === 422 && String((await json(notMine))['error']) === 'intake_not_owned', `status ${notMine.status}`)
  } finally {
    // ── cleanup (checked, FK order) + residue ────────────────────────────
    const errors: string[] = []
    const del = async (label: string, q: PromiseLike<{ error: { message: string } | null }>) => { const { error } = await q; if (error && !/Could not find the table/.test(error.message)) errors.push(`${label}: ${error.message}`) }
    try {
      const users = created.users
      for (const id of created.rfqIds) {
        await del('rfq_intake_extractions(rfq)', admin.from('rfq_intake_extractions').update({ rfq_id: null }).eq('rfq_id', id))
        await del('rfq_matches', admin.from('rfq_matches').delete().eq('rfq_id', id))
        await del('rfqs', admin.from('rfqs').delete().eq('id', id))
      }
      if (users.length) {
        await del('rfq_intake_extractions', admin.from('rfq_intake_extractions').delete().in('user_id', users))
        await del('ai_decisions', admin.from('ai_decisions').delete().in('decided_by', users))
        await del('ai_invocations', admin.from('ai_invocations').delete().in('user_id', users))
        await del('notifications', admin.from('notifications').delete().in('user_id', users))
      }
      for (const folder of created.msmeIds) {
        const objs = await listObjects(folder)
        if (objs.length) { const { error } = await admin.storage.from(BUCKET).remove(objs.map((o) => `${folder}/${o}`)); if (error) errors.push(`storage: ${error.message}`) }
      }
      for (const id of created.providerIds) {
        await del('provider_categories', admin.from('provider_categories').delete().eq('provider_id', id))
        await del('provider_profiles', admin.from('provider_profiles').delete().eq('id', id))
      }
      for (const id of created.msmeIds) await del('msme_profiles', admin.from('msme_profiles').delete().eq('id', id))
      for (const [key, before] of settingsBefore) {
        if (before.existed) await setSetting(key, before.value)
        else await admin.from('agent_settings').delete().eq('key', key)
      }
      for (const uid of users) {
        await del('users', admin.from('users').delete().eq('id', uid))
        const { error } = await admin.auth.admin.deleteUser(uid)
        if (error) errors.push(`auth ${uid}: ${error.message}`)
      }
      const residue: string[] = []
      const { count: u } = await admin.from('users').select('id', { count: 'exact', head: true }).like('email', `${tag}%`)
      if (u) residue.push(`users=${u}`)
      if (created.msmeIds.length) {
        const { count } = await admin.from('rfqs').select('id', { count: 'exact', head: true }).in('msme_id', created.msmeIds)
        if (count) residue.push(`rfqs=${count}`)
        for (const folder of created.msmeIds) { const objs = await listObjects(folder); if (objs.length) residue.push(`${BUCKET}/${folder}=${objs.length}`) }
      }
      if (created.users.length) {
        for (const [table, col] of [['rfq_intake_extractions', 'user_id'], ['ai_decisions', 'decided_by'], ['ai_invocations', 'user_id'], ['provider_profiles', 'user_id'], ['msme_profiles', 'user_id']] as const) {
          const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true }).in(col, created.users)
          if (!error && count) residue.push(`${table}=${count}`)
        }
      }
      if (errors.length) record('cleanup', 'FAIL', errors.join(' | '))
      else check(`cleanup: zero residue (${created.users.length} users, ${created.rfqIds.length} rfqs, settings restored)`, residue.length === 0, residue.join(', '))
    } catch (e) {
      record('cleanup', 'FAIL', (e as Error).message)
    }
  }
}

async function main() {
  offline()
  await http()
  console.log('')
  for (const r of rows) console.log(`  ${r.status === 'pass' ? '✓' : r.status === 'skip' ? '⏭' : '✗'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
  const pass = rows.filter((r) => r.status === 'pass').length
  const skips = rows.filter((r) => r.status === 'skip').length
  console.log(`\n${failed ? '❌' : '✅'} ${rows.length} checks: ${pass} pass, ${skips} skipped, ${failed} FAIL`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
