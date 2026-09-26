import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import {
  PRIVACY_REQUEST_OPEN_STATUSES,
  privacyRequestCreateSchema,
  privacyRequestDueAt,
  type PrivacyRequestView,
} from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * DPDP data-principal requests (ADR-030 §6; dpdp_requests, migration 0087).
 *
 *   GET  → the caller's own requests, newest first (session client: RLS "self read"), or { ready: false } before 0087.
 *   POST { kind, details?, source? } → files one on the service role after the caller is known; due in 30 days.
 *        One open request per kind per person (409 already_open with its due date). 503 not_ready before 0087.
 *
 * The person's own session only: a delegated agent token is refused (a request to erase an account is never an agent
 * action). Ops works the requests from the admin console.
 */

const COLUMNS = 'id, kind, status, details, resolution, due_at, created_at, resolved_at'

/** The table is absent (0087 not applied yet): PostgREST's schema-cache miss or Postgres's undefined table. */
function tableMissing(error: { code?: string | null } | null | undefined): boolean {
  return /^(42P01|PGRST205|PGRST204|42703)$/.test(String(error?.code ?? ''))
}

function view(r: Record<string, unknown>): PrivacyRequestView {
  return {
    id: String(r['id']),
    kind: r['kind'] as PrivacyRequestView['kind'],
    status: r['status'] as PrivacyRequestView['status'],
    details: (r['details'] as string | null) ?? null,
    resolution: (r['resolution'] as string | null) ?? null,
    dueAt: String(r['due_at']),
    createdAt: String(r['created_at']),
    resolvedAt: (r['resolved_at'] as string | null) ?? null,
  }
}

export async function GET() {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data, error } = await supabase
    .from('dpdp_requests')
    .select(COLUMNS)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) {
    if (tableMissing(error)) return NextResponse.json({ ready: false, requests: [] }, { headers: { 'Cache-Control': 'private, no-store' } })
    return serverError('[me/privacy-requests GET]', error)
  }
  return NextResponse.json({ ready: true, requests: (data ?? []).map((r) => view(r as Record<string, unknown>)) }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('me/privacy-requests')
  if (delegated) return delegated
  const rl = await enforce(limiters.privacyRequest, `privacy:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const parsed = privacyRequestCreateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    const problem = parsed.error.issues.find((i) => i.path[0] === 'details')?.message
    return NextResponse.json({ error: problem === 'details_required' || problem === 'details_too_long' ? problem : 'invalid_body' }, { status: 422 })
  }
  const { kind } = parsed.data
  const details = parsed.data.details?.trim() || null
  const source = parsed.data.source ?? (request.headers.get('x-amc-surface') === 'mobile' ? 'mobile' : 'web')

  const admin = await createAdminClient()
  const { data: open, error: openErr } = await admin
    .from('dpdp_requests')
    .select('id, due_at')
    .eq('user_id', userId)
    .eq('kind', kind)
    .in('status', [...PRIVACY_REQUEST_OPEN_STATUSES])
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle()
  if (openErr) {
    if (tableMissing(openErr)) return NextResponse.json({ error: 'not_ready' }, { status: 503 })
    return serverError('[me/privacy-requests POST open]', openErr)
  }
  if (open) return NextResponse.json({ error: 'already_open', id: open.id, dueAt: open.due_at }, { status: 409 })

  // The phone lets ops match a WhatsApp request from the same person; read on the service role (users is not client-readable in full).
  const { data: u } = await admin.from('users').select('phone').eq('id', userId).maybeSingle()
  const now = new Date()
  const { data: row, error } = await admin
    .from('dpdp_requests')
    .insert({
      user_id: userId,
      phone_e164: (u as { phone?: string | null } | null)?.phone ?? null,
      kind,
      source,
      status: 'open',
      details,
      due_at: privacyRequestDueAt(now).toISOString(),
    })
    .select(COLUMNS)
    .single()
  if (error) {
    if (tableMissing(error)) return NextResponse.json({ error: 'not_ready' }, { status: 503 })
    // dpdp_requests_one_open_per_kind: a concurrent request of the same kind won the insert — answer as the check above
    if ((error as { code?: string }).code === '23505') {
      const { data: again } = await admin.from('dpdp_requests').select('id, due_at').eq('user_id', userId).eq('kind', kind).in('status', ['open', 'in_progress']).is('deleted_at', null).limit(1).maybeSingle()
      if (again) return NextResponse.json({ error: 'already_open', id: (again as { id: string }).id, dueAt: (again as { due_at: string }).due_at }, { status: 409 })
    }
    return serverError('[me/privacy-requests POST insert]', error)
  }
  return NextResponse.json({ request: view(row as Record<string, unknown>) }, { status: 201 })
}
