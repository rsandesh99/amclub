import 'server-only'
import { randomUUID } from 'node:crypto'
import {
  daysBetween,
  dueReminderThreshold,
  classifyIntakeFile,
  COMING_DUE_DAYS,
  LICENCE_CERT_BUCKET,
  LICENCE_CERT_MAX_BYTES,
  LICENCE_TYPES,
  obligationsFor,
  obligationRuleSchema,
  ORDER_LICENCE_RECORDABLE_STATUSES,
  ORDER_REPEATABLE_STATUSES,
  renewHref,
  type LicenceCreateInput,
  type LicenceType,
  type LicenceView,
  type ObligationRule,
  type OrderLicenceFacts,
} from '@amclub/shared'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient, createPublicClient } from '@/lib/supabase/server'
import { getAgentSetting } from '@/lib/agent/settings'
import { resolveActor } from '@/lib/orders/actor'
import { todayIST } from '@/lib/agent/quote-extract'
import { createNotification } from '@/lib/notifications/create'
import { captureServerEvent } from '@/lib/analytics/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * PRD Experience v3 E9b (FR-9.5, N45 / F7; gated by D-PRD5). Every surface —
 * pages, /api/v1/me/licences, the order licence facts, the checklist and the
 * reminder cron — answers only while `agent_settings.obligations_enabled` is
 * on (default off). Reads go through the caller's session (RLS: owner only);
 * the two writes RLS cannot express (a licence confirmed from an order, the
 * provider's recorded facts) use the service role after an explicit party check.
 */
export async function isObligationsOn(admin?: Admin): Promise<boolean> {
  return (await getAgentSetting(admin ?? (await createAdminClient()), 'obligations_enabled').catch(() => false)) === true
}

type LicenceRow = {
  id: string
  licence_type: string
  licence_number: string | null
  issued_on: string | null
  expires_on: string | null
  authority: string | null
  source: string
  order_id: string | null
  certificate_path: string | null
}
const LICENCE_COLS = 'id, licence_type, licence_number, issued_on, expires_on, authority, source, order_id, certificate_path'

export function toLicenceView(r: LicenceRow, today = todayIST()): LicenceView {
  const type = r.licence_type as LicenceType
  return {
    id: r.id,
    licenceType: type,
    number: r.licence_number,
    issuedOn: r.issued_on,
    expiresOn: r.expires_on,
    authority: r.authority,
    source: r.source === 'order' ? 'order' : 'manual',
    hasCertificate: !!r.certificate_path,
    daysLeft: r.expires_on ? daysBetween(today, r.expires_on) : null,
    renewHref: renewHref(type),
  }
}

/** The caller's licences, soonest expiry first. `supabase` is the caller's own client: RLS decides ownership. */
export async function listMyLicences(supabase: SupabaseClient): Promise<LicenceView[]> {
  const { data } = await supabase.from('buyer_licences').select(LICENCE_COLS).is('deleted_at', null).order('expires_on', { ascending: true, nullsFirst: false })
  const today = todayIST()
  return ((data ?? []) as LicenceRow[]).filter((r) => r.licence_type in LICENCE_TYPES).map((r) => toLicenceView(r, today))
}

/** FR-9.5 "Coming due": licences expiring within 60 days (lapsed ones too, so they are renewed). */
export async function listComingDue(supabase: SupabaseClient): Promise<LicenceView[]> {
  return (await listMyLicences(supabase)).filter((l) => l.daysLeft !== null && l.daysLeft <= COMING_DUE_DAYS)
}

export type LicenceWriteResult = { ok: true; licence: LicenceView } | { ok: false; status: 403 | 404 | 409 | 422; code: string }

export async function createLicence(supabase: SupabaseClient, userId: string, input: LicenceCreateInput): Promise<LicenceWriteResult> {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.msmeId) return { ok: false, status: 403, code: 'profile_incomplete' }

  if ('fromOrderId' in input) {
    // Confirm what the provider recorded on the buyer's own finished order.
    const { data: order } = await admin.from('orders').select('id, msme_id, status').eq('id', input.fromOrderId).maybeSingle()
    if (!order || order.msme_id !== actor.msmeId) return { ok: false, status: 404, code: 'not_found' }
    if (!(ORDER_REPEATABLE_STATUSES as readonly string[]).includes(order.status as string)) return { ok: false, status: 409, code: 'not_completed' }
    const { data: facts } = await admin.from('order_licence_facts').select('licence_type, licence_number, issued_on, expires_on, authority').eq('order_id', order.id).maybeSingle()
    if (!facts) return { ok: false, status: 404, code: 'no_facts' }
    const { data: row, error } = await admin
      .from('buyer_licences')
      .insert({ msme_id: actor.msmeId, licence_type: facts.licence_type, licence_number: facts.licence_number, issued_on: facts.issued_on, expires_on: facts.expires_on, authority: facts.authority, source: 'order', order_id: order.id })
      .select(LICENCE_COLS)
      .single()
    if (error) return error.code === '23505' ? { ok: false, status: 409, code: 'already_added' } : { ok: false, status: 422, code: 'invalid' }
    captureServerEvent(userId, 'licence_added', { source: 'order' })
    return { ok: true, licence: toLicenceView(row as LicenceRow) }
  }

  // By hand: the caller's session writes its own row (RLS insert policy: own msme, source 'manual').
  const { data: row, error } = await supabase
    .from('buyer_licences')
    .insert({ msme_id: actor.msmeId, licence_type: input.licenceType, licence_number: input.number ?? null, issued_on: input.issuedOn ?? null, expires_on: input.expiresOn ?? null, authority: input.authority ?? null, source: 'manual' })
    .select(LICENCE_COLS)
    .single()
  if (error || !row) return { ok: false, status: 422, code: 'invalid' }
  captureServerEvent(userId, 'licence_added', { source: 'manual' })
  return { ok: true, licence: toLicenceView(row as LicenceRow) }
}

export async function updateLicence(supabase: SupabaseClient, id: string, patch: { number?: string | null | undefined; issuedOn?: string | null | undefined; expiresOn?: string | null | undefined; authority?: string | null | undefined }): Promise<LicenceWriteResult> {
  const { data: cur } = await supabase.from('buyer_licences').select(LICENCE_COLS).eq('id', id).is('deleted_at', null).maybeSingle()
  if (!cur) return { ok: false, status: 404, code: 'not_found' }
  const next = {
    ...(patch.number !== undefined ? { licence_number: patch.number } : {}),
    ...(patch.issuedOn !== undefined ? { issued_on: patch.issuedOn } : {}),
    ...(patch.expiresOn !== undefined ? { expires_on: patch.expiresOn } : {}),
    ...(patch.authority !== undefined ? { authority: patch.authority } : {}),
  }
  const { error } = await supabase.from('buyer_licences').update(next).eq('id', id)
  if (error) return { ok: false, status: 422, code: 'invalid' }
  const { data: row } = await supabase.from('buyer_licences').select(LICENCE_COLS).eq('id', id).single()
  return { ok: true, licence: toLicenceView(row as LicenceRow) }
}

/** Soft delete (rule 4): the row stays, the owner stops seeing it, reminders stop. */
export async function removeLicence(supabase: SupabaseClient, id: string): Promise<boolean> {
  const { data: cur } = await supabase.from('buyer_licences').select('id').eq('id', id).is('deleted_at', null).maybeSingle()
  if (!cur) return false
  const { error } = await supabase.from('buyer_licences').update({ deleted_at: new Date().toISOString() }).eq('id', id)
  return !error
}

// ── Certificate (private bucket; owner-only signed reads) ───────────────────────

/**
 * Audit L2 — certificate_path is writable by the owner's session (RLS), so a
 * stored value is trusted only when it is the shape storeLicenceCertificate
 * writes: `<msme_id>/<licence_id>/<file>`. Anything else is never signed or deleted.
 */
function ownCertificatePath(lic: { msme_id?: unknown; certificate_path?: unknown }, licenceId: string): string | null {
  const path = typeof lic.certificate_path === 'string' ? lic.certificate_path : null
  if (!path || typeof lic.msme_id !== 'string') return null
  const prefix = `${lic.msme_id}/${licenceId}/`
  return path.startsWith(prefix) && !path.slice(prefix.length).includes('/') && !path.includes('..') ? path : null
}
export async function storeLicenceCertificate(supabase: SupabaseClient, licenceId: string, file: File | null): Promise<{ ok: true } | { ok: false; status: 404 | 413 | 415 | 422 | 500; code: string }> {
  if (!file || file.size === 0) return { ok: false, status: 422, code: 'file_required' }
  if (file.size > LICENCE_CERT_MAX_BYTES) return { ok: false, status: 413, code: 'file_too_large' }
  const cls = classifyIntakeFile(file.name ?? '', file.type ?? '')
  if (!cls || (cls.kind !== 'image' && cls.kind !== 'pdf')) return { ok: false, status: 415, code: 'file_type_unsupported' }
  // Ownership through the caller's session (RLS): someone else's id reads nothing.
  const { data: lic } = await supabase.from('buyer_licences').select('id, msme_id, certificate_path').eq('id', licenceId).is('deleted_at', null).maybeSingle()
  if (!lic) return { ok: false, status: 404, code: 'not_found' }
  const admin = await createAdminClient()
  const path = `${lic.msme_id}/${licenceId}/${randomUUID()}.${cls.ext}`
  const mime = cls.kind === 'pdf' ? 'application/pdf' : file.type?.startsWith('image/') ? file.type : 'image/jpeg'
  const { error } = await admin.storage.from(LICENCE_CERT_BUCKET).upload(path, Buffer.from(await file.arrayBuffer()), { contentType: mime, upsert: false })
  if (error) return { ok: false, status: 500, code: 'upload_failed' }
  const { error: uErr } = await supabase.from('buyer_licences').update({ certificate_path: path }).eq('id', licenceId)
  if (uErr) { await admin.storage.from(LICENCE_CERT_BUCKET).remove([path]); return { ok: false, status: 500, code: 'update_failed' } }
  const previous = ownCertificatePath(lic, licenceId)
  if (previous) await admin.storage.from(LICENCE_CERT_BUCKET).remove([previous])
  return { ok: true }
}

/** A 15-minute signed link to the owner's own certificate, or null. */
export async function signedCertificateUrl(supabase: SupabaseClient, licenceId: string): Promise<string | null> {
  const { data: lic } = await supabase.from('buyer_licences').select('msme_id, certificate_path').eq('id', licenceId).is('deleted_at', null).maybeSingle()
  const path = lic ? ownCertificatePath(lic, licenceId) : null
  if (!path) return null
  const admin = await createAdminClient()
  const { data } = await admin.storage.from(LICENCE_CERT_BUCKET).createSignedUrl(path, 15 * 60)
  return data?.signedUrl ?? null
}

// ── "What do I need?" ──────────────────────────────────────────────────────────
export interface ObligationsView {
  facts: { activity: string | null; state: string | null; sizeBand: string | null }
  rules: (ObligationRule & { held: boolean })[]
}

/** The buyer's business facts (shown back for confirmation) and the reviewed rules that match them. */
export async function getMyObligations(supabase: SupabaseClient, userId: string): Promise<ObligationsView | null> {
  const { data: p } = await supabase.from('msme_profiles').select('sector, state, employee_band').eq('user_id', userId).maybeSingle()
  if (!p) return null
  const facts = { activity: (p.sector as string | null) ?? null, state: (p.state as string | null) ?? null, sizeBand: (p.employee_band as string | null) ?? null }
  // RLS returns reviewed rows only; the filter repeats it so a policy change can never widen the list.
  const { data: rows } = await createPublicClient().from('obligation_rules').select('id, activity, state, size_band, licence_type, category_slug, source_url, reviewed_by, reviewed_at').not('reviewed_at', 'is', null)
  const rules: ObligationRule[] = []
  for (const r of rows ?? []) {
    const parsed = obligationRuleSchema.safeParse({ id: r.id, activity: r.activity, state: r.state, sizeBand: r.size_band, licenceType: r.licence_type, categorySlug: r.category_slug, sourceUrl: r.source_url, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at })
    if (parsed.success) rules.push(parsed.data)
  }
  const held = new Set((await listMyLicences(supabase)).map((l) => l.licenceType))
  const matched = obligationsFor(facts as Parameters<typeof obligationsFor>[0], rules)
  return { facts, rules: matched.map((r) => ({ ...r, held: held.has(r.licenceType) })) }
}

// ── What the provider recorded on a registration order ─────────────────────────
export type OrderFactsView = { licenceType: LicenceType; number: string; issuedOn: string | null; expiresOn: string | null; authority: string | null; added: boolean }

/** Either party of the order may read the facts; `added` = the buyer already confirmed them into a licence. */
export async function getOrderLicenceFacts(userId: string, orderId: string): Promise<OrderFactsView | null | 'forbidden'> {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  const { data: order } = await admin.from('orders').select('id, msme_id, provider_id').eq('id', orderId).maybeSingle()
  if (!order) return null
  if (order.msme_id !== actor.msmeId && order.provider_id !== actor.providerId) return 'forbidden'
  const { data: f } = await admin.from('order_licence_facts').select('licence_type, licence_number, issued_on, expires_on, authority').eq('order_id', orderId).maybeSingle()
  if (!f) return null
  const { data: lic } = await admin.from('buyer_licences').select('id').eq('order_id', orderId).is('deleted_at', null).maybeSingle()
  return { licenceType: f.licence_type as LicenceType, number: f.licence_number as string, issuedOn: f.issued_on as string | null, expiresOn: f.expires_on as string | null, authority: f.authority as string | null, added: !!lic }
}

export async function recordOrderLicenceFacts(userId: string, orderId: string, facts: OrderLicenceFacts): Promise<{ ok: true } | { ok: false; status: 403 | 404 | 409; code: string }> {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  const { data: order } = await admin.from('orders').select('id, provider_id, status, kind').eq('id', orderId).maybeSingle()
  if (!order || order.kind === 'goods') return { ok: false, status: 404, code: 'not_found' }
  if (!actor.providerId || order.provider_id !== actor.providerId) return { ok: false, status: 403, code: 'not_provider' }
  if (!(ORDER_LICENCE_RECORDABLE_STATUSES as readonly string[]).includes(order.status as string)) return { ok: false, status: 409, code: 'not_started' }
  const { error } = await admin.from('order_licence_facts').upsert(
    { order_id: orderId, licence_type: facts.licenceType, licence_number: facts.number, issued_on: facts.issuedOn ?? null, expires_on: facts.expiresOn ?? null, authority: facts.authority ?? null, recorded_by: userId },
    { onConflict: 'order_id' },
  )
  if (error) return { ok: false, status: 409, code: 'invalid' }
  return { ok: true }
}

// ── Reminders (cron/licence-reminders, daily) ──────────────────────────────────
const LICENCE_LABEL: Record<LicenceType, { en: string; hi: string; te: string; ta: string }> = {
  fssai: { en: 'FSSAI licence', hi: 'FSSAI लाइसेंस', te: 'FSSAI లైసెన్స్', ta: 'FSSAI உரிமம்' },
  gst_registration: { en: 'GST registration', hi: 'GST पंजीकरण', te: 'GST నమోదు', ta: 'GST பதிவு' },
  udyam: { en: 'Udyam registration', hi: 'उद्यम पंजीकरण', te: 'ఉద్యమ్ నమోదు', ta: 'உத்யம் பதிவு' },
  iec: { en: 'Import-Export Code', hi: 'आयात-निर्यात कोड', te: 'ఇంపోర్ట్-ఎక్స్‌పోర్ట్ కోడ్', ta: 'இறக்குமதி-ஏற்றுமதி குறியீடு' },
  factory_licence: { en: 'factory licence', hi: 'फ़ैक्टरी लाइसेंस', te: 'ఫ్యాక్టరీ లైసెన్స్', ta: 'தொழிற்சாலை உரிமம்' },
  pollution_consent: { en: 'pollution consent', hi: 'प्रदूषण सहमति', te: 'కాలుష్య సమ్మతి', ta: 'மாசு ஒப்புதல்' },
  fire_noc: { en: 'fire NOC', hi: 'फ़ायर NOC', te: 'ఫైర్ NOC', ta: 'தீ NOC' },
  trade_licence: { en: 'trade licence', hi: 'ट्रेड लाइसेंस', te: 'ట్రేడ్ లైసెన్స్', ta: 'வர்த்தக உரிமம்' },
  shops_establishment: { en: 'shops & establishment registration', hi: 'दुकान और प्रतिष्ठान पंजीकरण', te: 'షాపులు & సంస్థల నమోదు', ta: 'கடைகள் & நிறுவனங்கள் பதிவு' },
  trademark: { en: 'trademark', hi: 'ट्रेडमार्क', te: 'ట్రేడ్‌మార్క్', ta: 'வர்த்தக முத்திரை' },
  professional_tax: { en: 'professional tax registration', hi: 'प्रोफ़ेशनल टैक्स पंजीकरण', te: 'ప్రొఫెషనల్ టాక్స్ నమోదు', ta: 'தொழில் வரி பதிவு' },
}

function istDay(date: string, locale: 'en' | 'hi' | 'te' | 'ta'): string {
  return new Date(`${date}T00:00:00+05:30`).toLocaleDateString(`${locale}-IN`, { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })
}

export interface ReminderRun { enabled: boolean; considered: number; sent: number }

/**
 * Daily. For every live licence expiring within 60 days, the ONE due threshold
 * (60 / 30 / 7) is claimed in `licence_reminders` — primary key
 * (licence_id, threshold_days) is the idempotency key — and only a claim this
 * run won notifies (in-app + the WhatsApp template when the buyer opted in).
 * A second run the same day finds every claim taken and sends nothing.
 */
export async function runLicenceReminders(admin: Admin, today = todayIST()): Promise<ReminderRun> {
  if (!(await isObligationsOn(admin))) return { enabled: false, considered: 0, sent: 0 }
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 60 * 86_400_000).toISOString().slice(0, 10)
  const { data } = await admin
    .from('buyer_licences')
    .select('id, licence_type, expires_on, msme:msme_profiles!inner(user_id)')
    .is('deleted_at', null)
    .gte('expires_on', today)
    .lte('expires_on', horizon)
    .limit(5000)
  type Row = { id: string; licence_type: string; expires_on: string; msme: { user_id: string } | { user_id: string }[] }
  const rows = ((data ?? []) as unknown as Row[]).filter((r) => r.licence_type in LICENCE_TYPES)
  if (rows.length === 0) return { enabled: true, considered: 0, sent: 0 }
  const { data: prior } = await admin.from('licence_reminders').select('licence_id, threshold_days').in('licence_id', rows.map((r) => r.id))
  const sentBy = new Map<string, number[]>()
  for (const p of prior ?? []) sentBy.set(p.licence_id as string, [...(sentBy.get(p.licence_id as string) ?? []), Number(p.threshold_days)])

  let sent = 0
  for (const r of rows) {
    const threshold = dueReminderThreshold(daysBetween(today, r.expires_on), sentBy.get(r.id) ?? [])
    if (threshold === null) continue
    const { data: claimed } = await admin
      .from('licence_reminders')
      .upsert({ licence_id: r.id, threshold_days: threshold }, { onConflict: 'licence_id,threshold_days', ignoreDuplicates: true })
      .select('licence_id')
    if (!claimed || claimed.length === 0) continue
    const userId = (Array.isArray(r.msme) ? r.msme[0]?.user_id : r.msme.user_id) as string | undefined
    if (!userId) continue
    const type = r.licence_type as LicenceType
    const label = LICENCE_LABEL[type]
    const link = renewHref(type)
    await createNotification(admin, {
      userId,
      kind: 'licence_renewal_due',
      titleI18n: { en: `Your ${label.en} expires on ${istDay(r.expires_on, 'en')}`, hi: `आपका ${label.hi} ${istDay(r.expires_on, 'hi')} को समाप्त होगा`, te: `మీ ${label.te} ${istDay(r.expires_on, 'te')}న గడువు ముగుస్తుంది`, ta: `உங்கள் ${label.ta} ${istDay(r.expires_on, 'ta')} அன்று காலாவதியாகும்` },
      bodyI18n: { en: 'Renew with a verified provider.', hi: 'किसी सत्यापित प्रदाता से नवीनीकरण करवाएँ।', te: 'ధృవీకరించిన ప్రొవైడర్‌తో పునరుద్ధరించండి.', ta: 'சரிபார்க்கப்பட்ட வழங்குநருடன் புதுப்பிக்கவும்.' },
      link,
      channels: ['whatsapp'],
    })
    captureServerEvent(userId, 'renewal_reminder_sent', { threshold })
    sent++
  }
  return { enabled: true, considered: rows.length, sent }
}
