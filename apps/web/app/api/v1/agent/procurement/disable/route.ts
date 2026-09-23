import { NextResponse } from 'next/server'
import { disableProcurement, procurementRouteContext, procurementStateView, PROCUREMENT_NO_STORE } from '@/lib/agent/procurement'

/**
 * POST /api/v1/agent/procurement/disable (S3.1) — revoke the web grant and remove the procurement scopes from the
 * WhatsApp grant (the channel itself stays for support / notifications). The next watch tick closes any open session
 * (failed, grant_revoked) and sends nothing further. Sessions and turns stay readable.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const ctx = await procurementRouteContext('POST /agent/procurement/disable')
  if (ctx.error) return ctx.error
  await disableProcurement(ctx.admin, { userId: ctx.userId })
  return NextResponse.json(await procurementStateView(ctx.admin, ctx.supabase, ctx.userId), { headers: PROCUREMENT_NO_STORE })
}
