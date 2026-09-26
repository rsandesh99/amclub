import 'server-only'
import {
  agentSettingDefault,
  canTransitionDpdpRequest,
  dpdpDueAt,
  dpdpOverdue,
  maskWaPhone,
  sortDpdpQueue,
  type DpdpAction,
  type DpdpCreate,
  type DpdpRequestKind,
  type DpdpRequestSource,
  type DpdpRequestStatus,
} from '@amclub/shared'
import { getAgentSetting } from '@/lib/agent/settings'
import { writeAudit } from '@/lib/audit/log'
import { createNotification } from '@/lib/notifications/create'
import { captureServerEvent } from '@/lib/analytics/server'
import { notReady, phoneDigits, type Admin } from './common'
import { dpdpAnswerI18n, dpdpAnswerText } from './copy'
import { eraseWhatsAppData, type WaErasureResult } from './erasure'

/**
 * ADR-030 §6 — the DPDP request queue (0087 `dpdp_requests`) worked from /admin/privacy. Requests arrive from the web,
 * mobile and WhatsApp ("MY DATA", "DELETE MY DATA"), or ops record one received by email. Ops move a request
 * open → in_progress → done | rejected (shared DPDP_REQUEST_TRANSITIONS; compare-and-set on the status). Marking an
 * erasure done runs the WhatsApp erasure first and appends the fixed sentence the user must read (what was erased, what
 * the law makes us keep) in their language. Every decision is audit-logged; the user gets an in-app notice.
 */

const COLS = 'id, user_id, phone_e164, kind, source, status, details, resolution, due_at, resolved_at, resolved_by, created_at, updated_at'

export interface DpdpRequestRow {
  id: string
  user_id: string | null
  phone_e164: string | null
  kind: DpdpRequestKind
  source: DpdpRequestSource
  status: DpdpRequestStatus
  details: string | null
  resolution: string | null
  due_at: string
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
  updated_at: string
}

export interface DpdpQueueRow extends Omit<DpdpRequestRow, 'phone_e164'> {
  phoneMasked: string | null
  user: { email: string | null; name: string | null; phoneMasked: string | null } | null
  overdue: boolean
}

export async function dpdpDueDays(admin: Admin): Promise<number> {
  try {
    const v = Number(await getAgentSetting(admin, 'dpdp_due_days'))
    return Number.isInteger(v) && v > 0 ? v : Number(agentSettingDefault('dpdp_due_days'))
  } catch {
    return Number(agentSettingDefault('dpdp_due_days'))
  }
}

export async function listDpdpRequests(admin: Admin, now = new Date()): Promise<{ notReady: true } | { notReady: false; requests: DpdpQueueRow[]; openCount: number; overdueCount: number }> {
  const { data, error } = await admin.from('dpdp_requests').select(COLS).is('deleted_at', null).order('created_at', { ascending: false }).limit(500)
  if (error) {
    if (notReady('dpdp_requests (0087)', error)) return { notReady: true }
    throw new Error(`dpdp_requests: ${error.message}`)
  }
  const rows = (data ?? []) as DpdpRequestRow[]
  const userIds = [...new Set(rows.map((r) => r.user_id).filter((u): u is string => !!u))]
  const { data: users } = userIds.length ? await admin.from('users').select('id, email, full_name, phone').in('id', userIds) : { data: [] }
  const byId = new Map(((users ?? []) as { id: string; email: string | null; full_name: string | null; phone: string | null }[]).map((u) => [u.id, u]))
  const out = sortDpdpQueue(rows).map((r) => {
    const u = r.user_id ? byId.get(r.user_id) : undefined
    const { phone_e164, ...rest } = r
    return { ...rest, phoneMasked: maskWaPhone(phone_e164), user: u ? { email: u.email, name: u.full_name, phoneMasked: maskWaPhone(u.phone) } : null, overdue: dpdpOverdue(r, now) }
  })
  return { notReady: false, requests: out, openCount: out.filter((r) => r.status === 'open' || r.status === 'in_progress').length, overdueCount: out.filter((r) => r.overdue).length }
}

export async function getDpdpRequest(admin: Admin, id: string): Promise<DpdpRequestRow | null> {
  const { data, error } = await admin.from('dpdp_requests').select(COLS).eq('id', id).is('deleted_at', null).maybeSingle()
  if (error) {
    if (notReady('dpdp_requests (0087)', error)) return null
    throw new Error(`dpdp_requests: ${error.message}`)
  }
  return (data as DpdpRequestRow | null) ?? null
}

/** The account an identifier names: its id, email or phone (a bare ten-digit mobile is read as +91). */
export async function resolveAccount(admin: Admin, identifier: string): Promise<{ id: string; phone: string | null } | null> {
  const s = identifier.trim()
  let q
  if (/^[0-9a-f-]{36}$/i.test(s)) q = admin.from('users').select('id, phone').eq('id', s)
  else if (s.includes('@')) q = admin.from('users').select('id, phone').in('email', [...new Set([s, s.toLowerCase()])]) // exact: never a LIKE pattern
  else {
    const d = phoneDigits(s)
    if (d.length < 10) return null
    const forms = d.length === 10 ? [`+91${d}`, `91${d}`, d] : [`+${d}`, d]
    q = admin.from('users').select('id, phone').in('phone', forms)
  }
  const { data } = await q.limit(1).maybeSingle()
  return (data as { id: string; phone: string | null } | null) ?? null
}

export async function createDpdpRequest(
  admin: Admin,
  request: Request | null,
  args: DpdpCreate & { actorId: string },
): Promise<{ ok: true; request: DpdpRequestRow } | { ok: false; error: 'no_account' | 'not_ready' }> {
  const account = await resolveAccount(admin, args.identifier)
  if (!account) return { ok: false, error: 'no_account' }
  const dueDays = await dpdpDueDays(admin)
  const now = new Date()
  const { data, error } = await admin
    .from('dpdp_requests')
    .insert({ user_id: account.id, phone_e164: phoneDigits(account.phone) || null, kind: args.kind, source: args.source, details: args.details ?? null, due_at: dpdpDueAt(now, dueDays) })
    .select(COLS)
    .single()
  if (error) {
    if (notReady('dpdp_requests (0087)', error)) return { ok: false, error: 'not_ready' }
    throw new Error(`dpdp_requests insert: ${error.message}`)
  }
  const row = data as DpdpRequestRow
  await writeAudit(admin, request, { actorId: args.actorId, action: 'dpdp_request_create', entity: 'dpdp_requests', entityId: row.id, before: null, after: { kind: row.kind, source: row.source, user_id: row.user_id, due_at: row.due_at } })
  return { ok: true, request: row }
}

export type DpdpActError = 'not_found' | 'illegal_transition' | 'changed' | 'not_ready' | 'erasure_incomplete' | 'no_account'

export async function actOnDpdpRequest(
  admin: Admin,
  request: Request | null,
  args: DpdpAction & { id: string; actorId: string },
): Promise<{ ok: true; request: DpdpRequestRow; erasure: WaErasureResult | null } | { ok: false; error: DpdpActError; erasure?: WaErasureResult }> {
  const before = await getDpdpRequest(admin, args.id)
  if (!before) return { ok: false, error: 'not_found' }
  if (!canTransitionDpdpRequest(before.status, args.action)) return { ok: false, error: 'illegal_transition' }

  let erasure: WaErasureResult | null = null
  let resolution = args.resolution?.trim() || null
  const final = args.action === 'done' || args.action === 'rejected'
  let locale: string | null = null
  if (before.user_id) {
    const { data: u } = await admin.from('users').select('preferred_locale').eq('id', before.user_id).maybeSingle()
    locale = (u as { preferred_locale?: string | null } | null)?.preferred_locale ?? null
  }

  if (args.action === 'done' && before.kind === 'erasure') {
    if (!before.user_id) return { ok: false, error: 'no_account' }
    erasure = await eraseWhatsAppData(admin, before.user_id)
    if (erasure.notReady) return { ok: false, error: 'not_ready', erasure }
    if (erasure.errors > 0) {
      await writeAudit(admin, request, { actorId: args.actorId, action: 'dpdp_erasure_incomplete', entity: 'dpdp_requests', entityId: before.id, before: { status: before.status }, after: { ...erasure } })
      return { ok: false, error: 'erasure_incomplete', erasure }
    }
    // the fixed part of every erasure answer (the user reads it; ops cannot leave it out)
    const fixed = [dpdpAnswerText(locale, 'erasure_done'), erasure.keptOnHold > 0 ? dpdpAnswerText(locale, 'erasure_kept_hold', { n: erasure.keptOnHold }) : null].filter(Boolean).join(' ')
    resolution = [resolution, fixed].filter(Boolean).join('\n\n')
  }

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { status: args.action }
  if (resolution !== null) patch['resolution'] = resolution.slice(0, 4000)
  if (final) { patch['resolved_at'] = now; patch['resolved_by'] = args.actorId }
  const { data: after, error } = await admin.from('dpdp_requests').update(patch).eq('id', before.id).eq('status', before.status).select(COLS).maybeSingle()
  if (error) {
    if (notReady('dpdp_requests (0087)', error)) return { ok: false, error: 'not_ready' }
    throw new Error(`dpdp_requests update: ${error.message}`)
  }
  if (!after) return { ok: false, error: 'changed' }
  const row = after as DpdpRequestRow
  await writeAudit(admin, request, {
    actorId: args.actorId,
    action: `dpdp_request_${args.action}`,
    entity: 'dpdp_requests',
    entityId: row.id,
    before: { status: before.status, resolution: before.resolution },
    after: { status: row.status, resolution: row.resolution, resolved_at: row.resolved_at, ...(erasure ? { erasure } : {}) },
  })
  if (final && row.user_id) {
    await createNotification(admin, {
      userId: row.user_id,
      kind: 'dpdp_request_answered',
      titleI18n: dpdpAnswerI18n('answered_title'),
      bodyI18n: dpdpAnswerI18n(row.status === 'done' ? 'answered_body_done' : 'answered_body_rejected'),
    })
  }
  captureServerEvent(args.actorId, 'dpdp_request_actioned', { kind: row.kind, source: row.source, action: args.action, overdue: dpdpOverdue(before, new Date()) })
  return { ok: true, request: row, erasure }
}
