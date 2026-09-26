import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { dpdpCreateSchema } from '@amclub/shared'
import { adminMutation, adminRead, NO_STORE } from '@/lib/privacy/route-guard'
import { createDpdpRequest, dpdpDueDays, listDpdpRequests } from '@/lib/privacy/requests'
import { readRetentionSettings } from '@/lib/privacy/retention'
import { serverError } from '@/lib/api/errors'

/**
 * GET  /api/v1/admin/privacy/requests (ADR-030 §6) — the DPDP queue: open work first by due date, overdue flagged; plus
 *      the retention settings and the last wa-retention run.
 * POST /api/v1/admin/privacy/requests { identifier, kind, source: email|admin, details? } — record a request received
 *      outside the product (the account is found by id, email or phone); due in `dpdp_due_days`. Audit-logged.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const g = await adminRead()
  if (g.error) return g.error
  try {
    const [queue, retention, dueDays, beat] = await Promise.all([
      listDpdpRequests(g.admin),
      readRetentionSettings(g.admin),
      dpdpDueDays(g.admin),
      g.admin.from('cron_heartbeats').select('last_ok_at, status, summary, last_result').eq('name', 'wa-retention').maybeSingle(),
    ])
    return NextResponse.json({ ...queue, retention, dueDays, lastRetentionRun: beat.data ?? null }, { headers: NO_STORE })
  } catch (e) {
    return serverError('[admin/privacy/requests]', e)
  }
}

export async function POST(request: NextRequest) {
  const g = await adminMutation('POST /admin/privacy/requests')
  if (g.error) return g.error
  const parsed = dpdpCreateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  try {
    const r = await createDpdpRequest(g.admin, request, { ...parsed.data, actorId: g.userId })
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === 'no_account' ? 404 : 409, headers: NO_STORE })
    return NextResponse.json({ request: r.request }, { status: 201, headers: NO_STORE })
  } catch (e) {
    return serverError('[admin/privacy/requests POST]', e)
  }
}
