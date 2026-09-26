/**
 * ADR-030 §4 (PRD_WHATSAPP W1) — the notification registry, preferences, outbox, fallback and reminders, against a
 * running app on a database with migration 0087 (CI: the disposable stack, flag-default server :3000). Drives the real
 * routes with per-user Bearer tokens and the two crons with CRON_SECRET; reads rows on the service role.
 *
 *   N1  GET /me/notification-preferences: ready, the full matrix, the essential categories; PUT saves (no quiet hours);
 *       a delegated agent token is refused (403)
 *   N2  the registry decides: provider_needs_info → WhatsApp + email rows, SMS held as the WhatsApp fallback
 *   N3  a preference turns WhatsApp off for the category → no WhatsApp row (SMS goes directly)
 *   N4  an essential category cannot lose every channel (PUT 422 essential_needs_channel); rows that say so anyway
 *       still leave the email floor
 *   N5  quiet hours defer a non-urgent WhatsApp (deferred until the window ends) but not the email, and not an urgent
 *       kind (order_placed to the provider stays queued)
 *   N6  the outbox is idempotent: a second row with the same key is refused; a second dispatch run sends nothing again
 *   N7  a WhatsApp that is not delivered (no consent / not live in CI) hands over: status fallback + SMS (DLT template
 *       set) and email rows with fallback_of, then sent by the next run
 *   N8  reminders go once: an order placed 13 h ago → one accept-by reminder over two cron runs, one claim row
 *   N9  a verification decision (needs_info, approve) and a dispute resolution notify (both parties, refund named once)
 *
 * Run: BASE_URL=http://localhost:3000 tsx scripts/verify-notifications.ts
 */
import { createHmac } from 'node:crypto'
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const URL = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'
const CRON = process.env['CRON_SECRET']
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }
const tag = `ntf_${Date.now()}`
const created = { users: [] as string[], providerIds: [] as string[], msmeIds: [] as string[], packageIds: [] as string[], orderIds: [] as string[] }
let dltBefore: { value: unknown } | null | undefined

let phoneSeq = 0
async function mkUser(label: string, roles: string[]): Promise<{ uid: string; token: string }> {
  const email = `${tag}_${label}@killtest.amclub`
  const digits = `9${String(Date.now()).slice(-6)}${String(++phoneSeq).padStart(3, '0')}`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(`${label}: ${error.message}`)
  created.users.push(data.user.id)
  const { error: uErr } = await admin.from('users').insert({ id: data.user.id, email, phone: `+91${digits}`, roles, preferred_locale: 'en' })
  if (uErr) throw new Error(`users insert ${label}: ${uErr.message}`)
  const anon = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
  return { uid: data.user.id, token: s.session!.access_token }
}

const api = (token: string, p: string, body?: unknown, method = 'POST') =>
  fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
const json = async (r: Response) => (await r.json().catch(() => ({}))) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const cron = (name: string) => fetch(`${BASE}/api/v1/cron/${name}`, { headers: CRON ? { Authorization: `Bearer ${CRON}` } : {} })

type Row = { id: string; channel: string; status: string; attempts: number; next_attempt_at: string; payload: { fallback?: string[] }; fallback_of: string | null; idempotency_key: string; kind: string }
async function outboxFor(notificationId: string): Promise<Row[]> {
  const { data } = await admin.from('notification_outbox').select('id, channel, status, attempts, next_attempt_at, payload, fallback_of, idempotency_key, kind').eq('notification_id', notificationId)
  return (data ?? []) as Row[]
}
async function latestNotification(userId: string, kind: string): Promise<{ id: string; channels: string[]; body_i18n: Record<string, string>; link: string | null } | null> {
  const { data } = await admin.from('notifications').select('id, channels, body_i18n, link').eq('user_id', userId).eq('kind', kind).order('created_at', { ascending: false }).limit(1)
  return (data?.[0] as never) ?? null
}
const channelsOf = (rows: Row[]) => rows.filter((r) => !r.fallback_of).map((r) => r.channel).sort().join(',')

/** An IST HH:MM `delta` minutes from now. */
function istHhmm(deltaMin: number): string {
  const m = ((Math.floor(Date.now() / 60000) + 330 + deltaMin) % 1440 + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
const CATS = ['orders', 'payments', 'requests', 'reminders', 'account', 'assistant', 'updates']
function prefs(over: Record<string, Partial<Record<'whatsapp' | 'sms' | 'email', boolean>>> = {}) {
  // Start from the defaults the server reports, then override.
  return CATS.flatMap((category) => (['whatsapp', 'sms', 'email'] as const).map((channel) => ({ category, channel, enabled: over[category]?.[channel] ?? defaults.get(`${category}:${channel}`) ?? false })))
}
const defaults = new Map<string, boolean>()
const settings = (p: ReturnType<typeof prefs>, quietHours: { start: string; end: string } | null = null) => ({ preferences: p, quietHours, pausedUntil: null, digestLeads: false })

async function placeOrder(buyerToken: string, packageId: string): Promise<string> {
  const co = await json(await api(buyerToken, '/api/v1/checkout', { packageId, idempotencyKey: crypto.randomUUID() }))
  if (!co['simulated']) throw new Error(`checkout did not simulate: ${JSON.stringify(co).slice(0, 200)}`)
  const sim = await json(await api(buyerToken, '/api/v1/checkout/simulate', { checkoutSessionId: co['checkoutSessionId'] }))
  const orderId = String(sim['orderId'] ?? '')
  if (!orderId) throw new Error(`simulate gave no order: ${JSON.stringify(sim).slice(0, 200)}`)
  created.orderIds.push(orderId)
  return orderId
}

async function main() {
  console.log(`\nNotifications (ADR-030 §4) → ${BASE}\n`)
  const probe = await admin.from('notification_outbox').select('id').limit(1)
  if (probe.error) {
    check('migration 0087 is applied (notification_outbox readable)', false, probe.error.message)
    return
  }
  try {
    const adminUser = await mkUser('admin', ['admin', 'ops'])
    const prov = await mkUser('prov', ['provider'])
    const buyer = await mkUser('buyer', ['msme'])
    const { data: pp } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'Ntf Prov', display_name: 'Ntf Prov', slug: `${tag}-prov`, state: 'KA', status: 'under_review', languages: ['en'] }).select('id').single()
    const providerId = pp!.id as string
    created.providerIds.push(providerId)
    const { data: m } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'Ntf Buyer', state: 'KA', sector: 'services' }).select('id').single()
    created.msmeIds.push(m!.id as string)

    // ── N1 preferences API ──
    const g = await api(prov.token, '/api/v1/me/notification-preferences', undefined, 'GET')
    const gb = await json(g)
    for (const p of (gb['settings']?.['preferences'] ?? []) as { category: string; channel: string; enabled: boolean }[]) defaults.set(`${p.category}:${p.channel}`, p.enabled)
    check('N1a GET → ready, the 7 × 3 matrix with defaults, the essential categories', g.status === 200 && gb['ready'] === true && defaults.size === 21 && defaults.get('orders:whatsapp') === true && defaults.get('updates:whatsapp') === false && JSON.stringify(gb['essentialCategories']) === JSON.stringify(['orders', 'payments', 'reminders', 'account']), `status ${g.status} ${JSON.stringify(gb).slice(0, 200)}`)
    const noQuiet = await api(prov.token, '/api/v1/me/notification-preferences', settings(prefs()), 'PUT')
    const nq = await json(noQuiet)
    check('N1b PUT defaults with no quiet hours → 200, quietHours null', noQuiet.status === 200 && nq['settings']?.['quietHours'] === null, `status ${noQuiet.status}`)
    // A delegated agent token (signed like lib/agent/token.ts mints them) never changes a person's choices.
    const jwtSecret = process.env['AUTHZ_JWT_SECRET']
    if (jwtSecret) {
      const b64u = (v: string) => Buffer.from(v).toString('base64url')
      const iat = Math.floor(Date.now() / 1000)
      const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      const payload = b64u(JSON.stringify({ sub: prov.uid, role: 'authenticated', aud: 'authenticated', iat, exp: iat + 600, amc_persona: 'provider', amc_scopes: ['support_lookup'] }))
      const token = `${head}.${payload}.${createHmac('sha256', jwtSecret).update(`${head}.${payload}`).digest('base64url')}`
      const del = await api(token, '/api/v1/me/notification-preferences', settings(prefs()), 'PUT')
      check('N1c a delegated agent token cannot change the preferences (403)', del.status === 403, `status ${del.status}`)
    } else {
      console.log('  (AUTHZ_JWT_SECRET unset — the delegated-token probe is skipped; CI sets it)')
    }

    const needsInfo = async (reason: string) => {
      const r = await api(adminUser.token, `/api/v1/admin/verifications/${providerId}`, { action: 'needs_info', reason })
      const n = await latestNotification(prov.uid, 'provider_needs_info')
      return { status: r.status, n, rows: n ? await outboxFor(n.id) : [] }
    }

    // ── N2 the registry decides ──
    const n2 = await needsInfo('Upload a readable GST certificate')
    const wa2 = n2.rows.find((r) => r.channel === 'whatsapp')
    check('N2 needs_info → 200, the provider is still pending, in-app row + WhatsApp and email rows (queued), SMS held as the fallback',
      n2.status === 200 && !!n2.n && channelsOf(n2.rows) === 'email,whatsapp' && JSON.stringify(wa2?.payload.fallback) === '["sms"]' && n2.rows.every((r) => r.status === 'queued') && JSON.stringify([...(n2.n?.channels ?? [])].sort()) === '["email","in_app","sms","whatsapp"]',
      `status ${n2.status} rows ${channelsOf(n2.rows)} fallback ${JSON.stringify(wa2?.payload.fallback)} channels ${JSON.stringify(n2.n?.channels)}`)
    const { data: still } = await admin.from('provider_profiles').select('status').eq('id', providerId).single()
    check('N2b needs_info leaves the application pending', still?.status === 'under_review', String(still?.status))

    // ── N3 a preference turns WhatsApp off for the category ──
    const offWa = await api(prov.token, '/api/v1/me/notification-preferences', settings(prefs({ account: { whatsapp: false } })), 'PUT')
    const n3 = await needsInfo('Add your bank statement')
    check('N3 account WhatsApp off → no WhatsApp row; SMS goes directly with email', offWa.status === 200 && channelsOf(n3.rows) === 'email,sms', `put ${offWa.status} rows ${channelsOf(n3.rows)}`)

    // ── N4 the essential floor ──
    const allOff = await api(prov.token, '/api/v1/me/notification-preferences', settings(prefs({ account: { whatsapp: false, sms: false, email: false } })), 'PUT')
    const ab = await json(allOff)
    check('N4a PUT with every account channel off → 422 essential_needs_channel', allOff.status === 422 && ab['error'] === 'essential_needs_channel' && JSON.stringify(ab['categories']) === '["account"]', `status ${allOff.status} ${JSON.stringify(ab)}`)
    await admin.from('notification_preferences').upsert(['whatsapp', 'sms', 'email'].map((channel) => ({ user_id: prov.uid, category: 'account', channel, enabled: false })), { onConflict: 'user_id,category,channel' })
    const n4 = await needsInfo('Confirm your registered address')
    check('N4b rows that switch every account channel off still leave the email floor on an essential kind', channelsOf(n4.rows) === 'email', `rows ${channelsOf(n4.rows)}`)

    // ── N5 quiet hours ──
    const quiet = { start: istHhmm(-60), end: istHhmm(60) }
    const q = await api(prov.token, '/api/v1/me/notification-preferences', settings(prefs(), quiet), 'PUT')
    const n5 = await needsInfo('Upload your PAN card')
    const wa5 = n5.rows.find((r) => r.channel === 'whatsapp')
    const em5 = n5.rows.find((r) => r.channel === 'email')
    const deferMin = wa5 ? (new Date(wa5.next_attempt_at).getTime() - Date.now()) / 60000 : 0
    check('N5a quiet hours defer a non-urgent WhatsApp to the end of the window; the email is not held',
      q.status === 200 && wa5?.status === 'deferred' && deferMin > 30 && deferMin <= 61 && em5?.status === 'queued',
      `put ${q.status} wa ${wa5?.status} +${deferMin.toFixed(0)} min, email ${em5?.status}`)

    // ── N7 set-up: WhatsApp alone, so an undelivered WhatsApp hands over to SMS and email ──
    const { data: dltRow } = await admin.from('agent_settings').select('value').eq('key', 'sms_dlt_templates').maybeSingle()
    dltBefore = dltRow ?? null
    await admin.from('agent_settings').upsert({ key: 'sms_dlt_templates', value: { provider_needs_info: { templateId: 'ci-flow-needs-info', vars: ['reason'] } }, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    const waOnly = await api(prov.token, '/api/v1/me/notification-preferences', settings(prefs({ account: { whatsapp: true, sms: false, email: false } })), 'PUT')
    const n7 = await needsInfo('Upload a cancelled cheque')
    const wa7 = n7.rows.find((r) => r.channel === 'whatsapp')
    check('N7a WhatsApp alone on an essential kind → one WhatsApp row holding SMS + email as its fallback', waOnly.status === 200 && channelsOf(n7.rows) === 'whatsapp' && JSON.stringify(wa7?.payload.fallback) === '["sms","email"]', `put ${waOnly.status} rows ${channelsOf(n7.rows)} fallback ${JSON.stringify(wa7?.payload.fallback)}`)

    // ── N6 idempotency ──
    const em2 = n2.rows.find((r) => r.channel === 'email')!
    const dup = await admin.from('notification_outbox').insert({ user_id: prov.uid, kind: 'provider_needs_info', channel: 'email', payload: {}, idempotency_key: em2.idempotency_key })
    check('N6a a second row with the same key is refused (unique idempotency key)', dup.error?.code === '23505', dup.error?.code ?? 'inserted')

    const run1 = await cron('notify-dispatch')
    const r1 = await json(run1)
    const em2a = (await outboxFor(n2.n!.id)).find((r) => r.id === em2.id)
    const run2 = await cron('notify-dispatch')
    const r2 = await json(run2)
    const em2b = (await outboxFor(n2.n!.id)).find((r) => r.id === em2.id)
    check('N6b dispatch runs → the email row is sent once (attempts 1 after both runs)', run1.status === 200 && r1['ready'] === true && run2.status === 200 && em2a?.status === 'sent' && em2b?.status === 'sent' && em2b?.attempts === 1, `run1 ${run1.status} ${JSON.stringify(r1)} run2 ${run2.status} ${JSON.stringify(r2)} email ${em2a?.status}/${em2b?.status} attempts ${em2b?.attempts}`)

    // ── N7 the fallback ──
    const rows7 = await outboxFor(n7.n!.id)
    const wa7b = rows7.find((r) => r.channel === 'whatsapp')
    const fb = rows7.filter((r) => r.fallback_of === wa7b?.id)
    check('N7b the undelivered WhatsApp → status fallback; SMS and email rows with fallback_of, sent by the next run (stubs)',
      wa7b?.status === 'fallback' && fb.map((r) => r.channel).sort().join(',') === 'email,sms' && fb.every((r) => r.status === 'sent'),
      `wa ${wa7b?.status} fallbacks ${fb.map((r) => `${r.channel}:${r.status}`).join(',')}`)
    const wa2b = (await outboxFor(n2.n!.id)).find((r) => r.channel === 'whatsapp')
    const fb2 = (await outboxFor(n2.n!.id)).filter((r) => r.fallback_of === wa2b?.id)
    check('N7c with email already sent, the fallback adds only the SMS (a channel is never doubled)', wa2b?.status === 'fallback' && fb2.map((r) => r.channel).join(',') === 'sms', `wa ${wa2b?.status} fallbacks ${fb2.map((r) => r.channel).join(',')}`)

    // ── N9a a verification decision notifies ──
    const appr = await api(adminUser.token, `/api/v1/admin/verifications/${providerId}`, { action: 'approve' })
    const verified = await latestNotification(prov.uid, 'provider_verified')
    check('N9a approve → 200 and a provider_verified notification', appr.status === 200 && !!verified, `status ${appr.status}`)

    // ── N5b an urgent kind ignores quiet hours ──
    const q2 = await api(prov.token, '/api/v1/me/notification-preferences', settings(prefs(), { start: istHhmm(-60), end: istHhmm(60) }), 'PUT')
    const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
    await admin.from('provider_categories').insert({ provider_id: providerId, category_id: cat!.id })
    const { data: pkg } = await admin.from('packages').insert({
      provider_id: providerId, category_id: cat!.id, slug: `${tag}-pkg`, title_i18n: { en: 'Ntf pkg', hi: 'Ntf' },
      price_paise: 123_456, discount_bps: 0, delivery_days: 3, revision_count: 1, status: 'active', scope_included: ['x'], scope_excluded: [], deliverables: ['y'],
    }).select('id').single()
    created.packageIds.push(pkg!.id as string)
    const order1 = await placeOrder(buyer.token, pkg!.id as string)
    const placed = await latestNotification(prov.uid, 'order_placed')
    const placedRows = placed ? await outboxFor(placed.id) : []
    const wa1 = placedRows.find((r) => r.channel === 'whatsapp')
    check('N5b inside quiet hours an urgent kind (order_placed to the provider) is queued, not deferred', q2.status === 200 && !!placed && placed.link === `/partner/orders/${order1}` && wa1?.status === 'queued', `put ${q2.status} wa ${wa1?.status}`)
    const receipt = await latestNotification(buyer.uid, 'order_placed')
    check('N5c the buyer gets their own receipt with the exact amount (WhatsApp + email)', !!receipt && /₹[\d,]+\.\d{2}/.test(receipt.body_i18n['en'] ?? '') && ['email', 'whatsapp'].every((c) => receipt.channels.includes(c)), JSON.stringify(receipt?.body_i18n?.['en']))

    // ── N8 reminders go once ──
    await admin.from('orders').update({ created_at: new Date(Date.now() - 13 * 3_600_000).toISOString() }).eq('id', order1)
    const rem1 = await cron('notify-reminders')
    const rb1 = await json(rem1)
    const rem2 = await cron('notify-reminders')
    const { data: reminders } = await admin.from('notifications').select('id, link').eq('user_id', prov.uid).eq('kind', 'order_accept_reminder')
    const { data: claims } = await admin.from('notification_reminders').select('stage').eq('kind', 'accept_by').eq('entity_id', order1)
    check('N8 an order placed 13 h ago → one accept-by reminder over two runs, one 12h claim', rem1.status === 200 && rb1['ready'] === true && rem2.status === 200 && (reminders ?? []).filter((r) => r.link === `/partner/orders/${order1}`).length === 1 && JSON.stringify((claims ?? []).map((c) => c.stage)) === '["12h"]', `run ${rem1.status} ${JSON.stringify(rb1)} reminders ${(reminders ?? []).length} claims ${JSON.stringify(claims)}`)

    // ── N9b a dispute resolution notifies both parties ──
    const order2 = await placeOrder(buyer.token, pkg!.id as string)
    await api(prov.token, `/api/v1/orders/${order2}/transition`, { action: 'accept' })
    await api(buyer.token, `/api/v1/orders/${order2}/transition`, { action: 'submit_requirements' })
    await api(prov.token, `/api/v1/orders/${order2}/transition`, { action: 'start' })
    await api(prov.token, `/api/v1/orders/${order2}/transition`, { action: 'deliver' })
    const disp = await api(buyer.token, `/api/v1/orders/${order2}/transition`, { action: 'raise_dispute', disputeReason: 'notification rig' })
    const { data: d } = await admin.from('disputes').select('id').eq('order_id', order2).maybeSingle()
    const res = d ? await api(adminUser.token, `/api/v1/admin/disputes/${d.id}/resolve`, { resolution: 'refund_full' }) : null
    const { data: resolved } = await admin.from('notifications').select('user_id, body_i18n').eq('kind', 'dispute_resolved').like('link', `%${order2}%`)
    const buyerNote = (resolved ?? []).find((r) => r.user_id === buyer.uid)
    const provNote = (resolved ?? []).find((r) => r.user_id === prov.uid)
    const { count: refundNotes } = await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', buyer.uid).eq('kind', 'refund_processed').like('link', `%${order2}%`)
    check('N9b refund_full → dispute_resolved to the buyer (with the exact refund) and the provider; no second refund notice',
      disp.status === 200 && res?.status === 200 && !!buyerNote && !!provNote && /₹[\d,]+\.\d{2}/.test(String((buyerNote?.body_i18n as Record<string, string>)?.['en'] ?? '')) && (refundNotes ?? 0) === 0,
      `dispute ${disp.status} resolve ${res?.status} buyer ${!!buyerNote} provider ${!!provNote} refund notices ${refundNotes} ${JSON.stringify(buyerNote?.body_i18n)}`)
  } finally {
    console.log('\n🧹 cleanup…')
    const t = async (p: PromiseLike<{ error?: { message: string } | null } | unknown>) => {
      const r = (await Promise.resolve(p).catch((e) => ({ error: e }))) as { error?: { message?: string } | null }
      if (r && r.error) console.error('  cleanup:', r.error.message ?? String(r.error))
    }
    if (dltBefore !== undefined) {
      if (dltBefore) await t(admin.from('agent_settings').upsert({ key: 'sms_dlt_templates', value: dltBefore.value, updated_at: new Date().toISOString() }, { onConflict: 'key' }))
      else await t(admin.from('agent_settings').delete().eq('key', 'sms_dlt_templates'))
    }
    for (const mid of created.msmeIds) await t(admin.from('checkout_sessions').delete().eq('msme_id', mid))
    for (const oid of created.orderIds) {
      await t(admin.from('notification_reminders').delete().eq('entity_id', oid))
      await t(admin.from('checkout_sessions').delete().eq('order_id', oid))
      const { data: pays } = await admin.from('payments').select('id').eq('order_id', oid)
      for (const pay of pays ?? []) await t(admin.from('refunds').delete().eq('payment_id', pay.id))
      await t(admin.from('disputes').delete().eq('order_id', oid))
      await t(admin.from('payouts').delete().eq('order_id', oid))
      await t(admin.from('payments').delete().eq('order_id', oid))
      await t(admin.from('invoices').delete().eq('order_id', oid))
      await t(admin.from('order_events').delete().eq('order_id', oid))
      await t(admin.from('order_documents').delete().eq('order_id', oid))
      await t(admin.from('orders').delete().eq('id', oid))
    }
    for (const id of created.packageIds) await t(admin.from('packages').delete().eq('id', id))
    for (const id of created.providerIds) {
      await t(admin.from('provider_verifications').delete().eq('provider_id', id))
      await t(admin.from('provider_categories').delete().eq('provider_id', id))
      await t(admin.from('provider_profiles').delete().eq('id', id))
    }
    for (const mid of created.msmeIds) await t(admin.from('msme_profiles').delete().eq('id', mid))
    for (const uid of created.users) {
      await t(admin.from('notification_outbox').delete().eq('user_id', uid))
      await t(admin.from('notification_reminders').delete().eq('user_id', uid))
      await t(admin.from('notification_preferences').delete().eq('user_id', uid))
      await t(admin.from('notification_settings').delete().eq('user_id', uid))
      await t(admin.from('audit_logs').delete().eq('actor_id', uid))
      await t(admin.from('notifications').delete().eq('user_id', uid))
      await t(admin.from('users').delete().eq('id', uid))
      await admin.auth.admin.deleteUser(uid).catch(() => {})
    }
  }
  console.log(`\n${fail === 0 ? '✅ NOTIFICATIONS — ALL CRITERIA PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
