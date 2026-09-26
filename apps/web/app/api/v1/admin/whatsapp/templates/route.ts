import { NextResponse } from 'next/server'
import { adminRead, NO_STORE } from '@/lib/privacy/route-guard'
import { waDriverState, waTemplatesReport } from '@/lib/whatsapp/admin'
import { serverError } from '@/lib/api/errors'

/**
 * GET /api/v1/admin/whatsapp/templates (ADR-030 §3 / §6) — Meta's template rows (wa_templates, synced) next to the
 * code registry: name, language, category, status, rejection reason, synced time, flagged "in code, not approved" and
 * "approved, not in code".
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const g = await adminRead()
  if (g.error) return g.error
  try {
    const report = await waTemplatesReport(g.admin)
    const d = waDriverState()
    return NextResponse.json({ ...report, syncConfigured: d.wabaIdSet && d.tokenSet }, { headers: NO_STORE })
  } catch (e) {
    return serverError('[admin/whatsapp/templates]', e)
  }
}
