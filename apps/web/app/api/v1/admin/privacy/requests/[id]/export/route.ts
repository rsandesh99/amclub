import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { adminMutation, isUuid, NO_STORE, notReadyResponse } from '@/lib/privacy/route-guard'
import { getDpdpRequest } from '@/lib/privacy/requests'
import { buildUserExport } from '@/lib/privacy/export'
import { writeAudit } from '@/lib/audit/log'
import { serverError } from '@/lib/api/errors'

/**
 * GET /api/v1/admin/privacy/requests/[id]/export (ADR-030 §6, DPDP s.11) — the JSON export for an access request, as a
 * download (profile, orders summary, requests, consents, WhatsApp messages of the account's conversations,
 * notifications). Treated as a mutation for its guard (a full personal-data read): no delegated token, rate-limited,
 * and every download is audit-logged (`dpdp_export`).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await adminMutation('GET /admin/privacy/requests/[id]/export')
  if (g.error) return g.error
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const req = await getDpdpRequest(g.admin, id)
    if (!req) {
      const probe = await g.admin.from('dpdp_requests').select('id').limit(1)
      return probe.error ? notReadyResponse() : NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    if (req.kind !== 'access') return NextResponse.json({ error: 'not_an_access_request' }, { status: 409, headers: NO_STORE })
    if (!req.user_id) return NextResponse.json({ error: 'no_account' }, { status: 409, headers: NO_STORE })
    const doc = await buildUserExport(g.admin, req.user_id)
    if (!doc) return NextResponse.json({ error: 'no_account' }, { status: 409, headers: NO_STORE })
    const body = JSON.stringify(doc, null, 2)
    await writeAudit(g.admin, request, { actorId: g.userId, action: 'dpdp_export', entity: 'dpdp_requests', entityId: req.id, before: null, after: { user_id: req.user_id, bytes: body.length } })
    return new NextResponse(body, {
      status: 200,
      headers: {
        ...NO_STORE,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="amclub-data-${req.id.slice(0, 8)}.json"`,
      },
    })
  } catch (e) {
    return serverError('[admin/privacy/export]', e)
  }
}
