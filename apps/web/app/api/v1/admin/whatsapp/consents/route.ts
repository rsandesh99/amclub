import { NextResponse } from 'next/server'
import { adminRead, NO_STORE } from '@/lib/privacy/route-guard'
import { waConsentsReport } from '@/lib/whatsapp/admin'
import { serverError } from '@/lib/api/errors'

/**
 * GET /api/v1/admin/whatsapp/consents (ADR-030 §2 / §6) — opted-in / opted-out phones per purpose, the latest opt-outs
 * (masked) and the delivery-driven suppressions (each addressed by an opaque key for "Clear").
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const g = await adminRead()
  if (g.error) return g.error
  try {
    return NextResponse.json(await waConsentsReport(g.admin), { headers: NO_STORE })
  } catch (e) {
    return serverError('[admin/whatsapp/consents]', e)
  }
}
