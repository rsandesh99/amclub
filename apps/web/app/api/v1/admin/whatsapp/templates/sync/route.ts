import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { adminMutation, NO_STORE } from '@/lib/privacy/route-guard'
import { syncWaTemplates } from '@/lib/whatsapp/admin'
import { stableEntityId, writeAudit } from '@/lib/audit/log'
import { serverError } from '@/lib/api/errors'

/**
 * POST /api/v1/admin/whatsapp/templates/sync (ADR-030 §6) — "Sync now": pull Meta's template list into wa_templates
 * (the daily cron wa-template-sync does the same). 409 not_configured without WHATSAPP_WABA_ID + the token; 409
 * not_ready before 0086; 502 when Graph refused (the message is Meta's, never the token). Audit-logged.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const g = await adminMutation('POST /admin/whatsapp/templates/sync')
  if (g.error) return g.error
  try {
    const r = await syncWaTemplates(g.admin)
    if (!r.configured) return NextResponse.json({ error: 'not_configured' }, { status: 409, headers: NO_STORE })
    if (r.notReady) return NextResponse.json({ error: 'not_ready' }, { status: 409, headers: NO_STORE })
    await writeAudit(g.admin, request, { actorId: g.userId, action: 'wa_templates_sync', entity: 'wa_templates', entityId: stableEntityId('wa_templates', 'sync'), before: null, after: { fetched: r.fetched, upserted: r.upserted, marked_deleted: r.markedDeleted, pages: r.pages, complete: r.complete, error: r.error ?? null } })
    if (r.error && r.upserted === 0) return NextResponse.json({ error: 'graph_failed', detail: r.error }, { status: 502, headers: NO_STORE })
    return NextResponse.json(r, { headers: NO_STORE })
  } catch (e) {
    return serverError('[admin/whatsapp/templates/sync]', e)
  }
}
