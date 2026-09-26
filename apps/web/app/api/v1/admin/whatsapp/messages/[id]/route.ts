import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { adminRead, isUuid, NO_STORE, notReadyResponse } from '@/lib/privacy/route-guard'
import { waMessageDetail } from '@/lib/whatsapp/admin'
import { writeAudit } from '@/lib/audit/log'
import { serverError } from '@/lib/api/errors'

/**
 * GET /api/v1/admin/whatsapp/messages/[id] (ADR-030 §6) — one message with its text. Every read of a message body is
 * audit-logged (`wa_message_read`), like a ticket transcript.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await adminRead()
  if (g.error) return g.error
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const m = await waMessageDetail(g.admin, id)
    if (m === 'not_ready') return notReadyResponse()
    if (!m) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await writeAudit(g.admin, request, { actorId: g.userId, action: 'wa_message_read', entity: 'wa_messages', entityId: m.id, before: null, after: { direction: m.direction, kind: m.kind, redacted: !!m.redactedAt } })
    return NextResponse.json({ message: m }, { headers: NO_STORE })
  } catch (e) {
    return serverError('[admin/whatsapp/messages/id]', e)
  }
}
