import { NextResponse } from 'next/server'
import { adminRead, NO_STORE } from '@/lib/privacy/route-guard'
import { waUnrouted } from '@/lib/whatsapp/admin'
import { serverError } from '@/lib/api/errors'

/**
 * GET /api/v1/admin/whatsapp/unrouted (ADR-030 §6) — inbound messages of the last 7 days from numbers with no bound
 * account: masked phone, time, kind, the first 80 characters (secrets removed), whether the 24-hour window is open and
 * whether an AMClub account holds the number (for "Open ticket").
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const g = await adminRead()
  if (g.error) return g.error
  try {
    return NextResponse.json({ rows: await waUnrouted(g.admin) }, { headers: NO_STORE })
  } catch (e) {
    return serverError('[admin/whatsapp/unrouted]', e)
  }
}
