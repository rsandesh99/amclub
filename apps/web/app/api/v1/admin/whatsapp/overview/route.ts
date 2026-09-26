import { NextResponse } from 'next/server'
import { adminRead, NO_STORE } from '@/lib/privacy/route-guard'
import { waOverview } from '@/lib/whatsapp/admin'
import { serverError } from '@/lib/api/errors'

/** GET /api/v1/admin/whatsapp/overview (ADR-030 §6) — driver state (never a secret), Graph version, number quality and
 *  messaging tier from the latest account webhooks, the last inbound and last status webhook times. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const g = await adminRead()
  if (g.error) return g.error
  try {
    return NextResponse.json(await waOverview(g.admin), { headers: NO_STORE })
  } catch (e) {
    return serverError('[admin/whatsapp/overview]', e)
  }
}
