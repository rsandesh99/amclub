/**
 * verify-content-translation.ts — E14 FR-14.3 (N32b) provider content translation,
 * against a running server. The dark half (surface 404s, a draft never renders,
 * an approved slot is labelled) runs in CI inside verify-experience (e14c). This
 * rig drives the flag-on half: run it against a server started with
 * AGENT_ENABLED=true (keyless = the stub drafts; with a key = real drafts).
 *
 *   BASE_URL=http://localhost:3000 tsx scripts/verify-content-translation.ts
 *
 * Criteria:
 *   1. a draft is written for each field with English (title + "Choose this if…") and nothing a buyer sees changes;
 *   2. an approved text with the source's numbers → the slot + source machine_approved + EXACTLY one ai_decisions row;
 *   3. a second approve of the same draft → 409, still one row;
 *   4. an edit that changes a number → 422, the slot untouched;
 *   5. an English change after the draft → 409 source_changed (the draft goes stale);
 *   6. another provider can neither list, approve nor discard it.
 * It touches agent_settings (agents_enabled, cohort_user_ids) and restores them.
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = (process.env['BASE_URL'] ?? 'http://localhost:3000').replace(/\/$/, '')
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })

let pass = 0, fail = 0, skipped = 0
const check = (n: string, ok: boolean, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }
const tag = `ctv_${Date.now()}`
const users: string[] = []

async function mkProvider(label: string): Promise<{ uid: string; token: string; providerId: string }> {
  const email = `${tag}_${label}@killtest.amclub`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(`${label}: ${error.message}`)
  users.push(data.user.id)
  await admin.from('users').insert({ id: data.user.id, email, roles: ['provider'] })
  const { data: s } = await createClient(URL_, ANON, { auth: { persistSession: false } }).auth.signInWithPassword({ email, password: 'Test1234!' })
  const { data: pp } = await admin.from('provider_profiles').insert({ user_id: data.user.id, legal_name: label, display_name: label, slug: `${tag.replace(/_/g, '-')}-${label}`, state: 'TS', status: 'active', languages: ['en'], about: 'Filing GST for 12 months since 2015.' }).select('id').single()
  return { uid: data.user.id, token: s.session!.access_token, providerId: pp!.id as string }
}
const api = (token: string, p: string, body?: unknown, method = 'POST') => fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })

async function setSetting(key: string, value: unknown): Promise<() => Promise<void>> {
  const { data: before } = await admin.from('agent_settings').select('value').eq('key', key).maybeSingle()
  await admin.from('agent_settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  return async () => {
    if (before) await admin.from('agent_settings').upsert({ key, value: before.value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    else await admin.from('agent_settings').delete().eq('key', key)
  }
}

async function main() {
  console.log(`\nverify-content-translation → ${BASE}\n`)
  const me = await mkProvider('ctme')
  const other = await mkProvider('ctother')
  const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
  const { data: pk } = await admin.from('packages').insert({ provider_id: me.providerId, category_id: cat!.id, slug: `${tag.replace(/_/g, '-')}-pkg`, title_i18n: { en: 'GST filing for 12 months' }, ideal_for_i18n: { en: 'Choose this if you file 3 GSTINs' }, scope_included: ['x'], deliverables: ['y'], price_paise: 1000_00, delivery_days: 5, status: 'active' }).select('id').single()
  const pkgId = pk!.id as string
  const restores: (() => Promise<void>)[] = []
  try {
    const probe = await api(me.token, '/api/v1/partner/translations', undefined, 'GET')
    if (probe.status === 404) {
      const { data: ae } = await admin.from('agent_settings').select('value').eq('key', 'agents_enabled').maybeSingle()
      restores.push(await setSetting('agents_enabled', { ...((ae?.value as Record<string, boolean> | null) ?? {}), content_translate: true }))
      restores.push(await setSetting('cohort_user_ids', [me.uid, other.uid]))
    }
    const list = await api(me.token, '/api/v1/partner/translations', undefined, 'GET')
    if (list.status === 404) {
      console.log('  · the server is dark (AGENT_ENABLED off) — nothing to drive; start it with AGENT_ENABLED=true')
      skipped++
      return
    }
    // 1 — drafts, nothing visible.
    const dr = (await (await api(me.token, '/api/v1/partner/translations/draft', { subjectKind: 'package', subjectId: pkgId, lang: 'te' })).json()) as { drafts?: { id: string; field: string; draftText: string }[]; skipped?: unknown[] }
    const drafts = dr.drafts ?? []
    const title = drafts.find((d) => d.field === 'title')
    const { data: afterDraft } = await admin.from('packages').select('title_i18n, i18n_sources').eq('id', pkgId).single()
    check('1: a draft per field (title + "Choose this if…"), nothing a buyer sees changes', drafts.length === 2 && !!title && !(afterDraft?.title_i18n as Record<string, string>)['te'] && !afterDraft?.i18n_sources, JSON.stringify({ n: drafts.length, skipped: dr.skipped }))
    // 6 — another provider cannot see or act on it.
    const theirs = (await (await api(other.token, '/api/v1/partner/translations', undefined, 'GET')).json()) as { drafts?: unknown[] }
    const steal = await api(other.token, `/api/v1/partner/translations/${title!.id}/approve`, { text: 'GST ఫైలింగ్ 12 నెలలు' })
    const stealDiscard = await api(other.token, `/api/v1/partner/translations/${title!.id}/reject`, {})
    check('6: another provider cannot list, approve or discard it', (theirs.drafts ?? []).length === 0 && steal.status === 409 && stealDiscard.status === 409, `${steal.status}/${stealDiscard.status}`)
    // 4 — an edit that changes a number is refused, the slot untouched.
    const bad = await api(me.token, `/api/v1/partner/translations/${title!.id}/approve`, { text: 'GST ఫైలింగ్ 6 నెలలు' })
    const { data: afterBad } = await admin.from('packages').select('title_i18n').eq('id', pkgId).single()
    check('4: an edit that changes a number → 422, the slot untouched', bad.status === 422 && !(afterBad?.title_i18n as Record<string, string>)['te'], String(bad.status))
    // 2 — approve (edited, numbers kept): the slot, its source, ONE decision row.
    const ok = await api(me.token, `/api/v1/partner/translations/${title!.id}/approve`, { text: '12 నెలల GST ఫైలింగ్' })
    const { data: afterOk } = await admin.from('packages').select('title_i18n, i18n_sources').eq('id', pkgId).single()
    const { count: decisions } = await admin.from('ai_decisions').select('id', { count: 'exact', head: true }).eq('feature', 'content_translation').eq('decided_by', me.uid)
    check('2: approve → the te slot + source machine_approved + exactly one ai_decisions row', ok.ok && (afterOk?.title_i18n as Record<string, string>)['te'] === '12 నెలల GST ఫైలింగ్' && (afterOk?.i18n_sources as { title?: { te?: string } })?.title?.te === 'machine_approved' && decisions === 1, `status ${ok.status}, decisions ${decisions}`)
    // 3 — approve again: 409, still one row.
    const again = await api(me.token, `/api/v1/partner/translations/${title!.id}/approve`, {})
    const { count: decisions2 } = await admin.from('ai_decisions').select('id', { count: 'exact', head: true }).eq('feature', 'content_translation').eq('decided_by', me.uid)
    check('3: a second approve → 409, still one ai_decisions row', again.status === 409 && decisions2 === 1, `${again.status} / ${decisions2}`)
    // 5 — English changes after a draft: the draft goes stale.
    const ideal = drafts.find((d) => d.field === 'ideal_for')
    await admin.from('packages').update({ ideal_for_i18n: { en: 'Choose this if you file 4 GSTINs' } }).eq('id', pkgId)
    const stale = await api(me.token, `/api/v1/partner/translations/${ideal!.id}/approve`, {})
    const { data: st } = await admin.from('content_translations').select('status').eq('id', ideal!.id).single()
    check('5: the English changed after the draft → 409 source_changed, the draft is stale', stale.status === 409 && st?.status === 'stale', String(stale.status))
  } finally {
    for (const r of restores.reverse()) await r()
    await admin.from('ai_decisions').delete().eq('feature', 'content_translation').in('decided_by', users)
    await admin.from('content_translations').delete().in('provider_id', [me.providerId, other.providerId])
    await admin.from('packages').delete().eq('id', pkgId)
    await admin.from('provider_profiles').delete().in('id', [me.providerId, other.providerId])
    for (const uid of users) { await admin.from('users').delete().eq('id', uid); await admin.auth.admin.deleteUser(uid).catch(() => {}) }
  }
}

main()
  .then(() => { console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n`); process.exit(fail ? 1 : 0) })
  .catch((e) => { console.error(e); process.exit(1) })
