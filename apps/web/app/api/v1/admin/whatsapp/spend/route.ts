import { NextResponse } from 'next/server'
import { adminRead, NO_STORE } from '@/lib/privacy/route-guard'
import { waSpendReport } from '@/lib/whatsapp/admin'
import { serverError } from '@/lib/api/errors'

/**
 * GET /api/v1/admin/whatsapp/spend (ADR-030 §3 / §6) — WhatsApp cost per IST day and category over 30 days, with
 * counts. Costs are summed as integer millipaise and formatted to ₹ here, on the server (excl. 18 % GST).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const g = await adminRead()
  if (g.error) return g.error
  try {
    return NextResponse.json(await waSpendReport(g.admin), { headers: NO_STORE })
  } catch (e) {
    return serverError('[admin/whatsapp/spend]', e)
  }
}
