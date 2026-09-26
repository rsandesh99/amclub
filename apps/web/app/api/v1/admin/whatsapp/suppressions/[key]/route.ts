import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { maskWaPhone } from '@amclub/shared'
import { adminMutation, NO_STORE, notReadyResponse } from '@/lib/privacy/route-guard'
import { findSuppression } from '@/lib/whatsapp/admin'
import { stableEntityId, writeAudit } from '@/lib/audit/log'
import { serverError } from '@/lib/api/errors'

/**
 * DELETE /api/v1/admin/whatsapp/suppressions/[key] (ADR-030 §2 / §6) — "Clear": ops lift a delivery-driven suppression
 * (e.g. the person is on WhatsApp now). It never touches consent: a STOPped phone stays opted out. Audit-logged with the
 * row as it was (phone masked).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const g = await adminMutation('DELETE /admin/whatsapp/suppressions/[key]')
  if (g.error) return g.error
  const { key } = await params
  if (!/^[0-9a-f]{32}$/.test(key)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const row = await findSuppression(g.admin, key)
    if (row === 'not_ready') return notReadyResponse()
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const { data: gone, error } = await g.admin.from('wa_suppressions').delete().eq('phone_e164', row.phone_e164).select('phone_e164')
    if (error) return serverError('[admin/whatsapp/suppressions] delete', error)
    if ((gone ?? []).length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await writeAudit(g.admin, request, {
      actorId: g.userId,
      action: 'wa_suppression_clear',
      entity: 'wa_suppressions',
      entityId: stableEntityId('wa_suppressions', row.phone_e164),
      before: { phone: maskWaPhone(row.phone_e164), reason: row.reason, error_code: row.error_code, until: row.until },
      after: null,
    })
    return NextResponse.json({ cleared: true }, { headers: NO_STORE })
  } catch (e) {
    return serverError('[admin/whatsapp/suppressions]', e)
  }
}
