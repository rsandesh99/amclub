import { NextResponse } from 'next/server'
import { procurementRouteContext, procurementStateView, PROCUREMENT_NO_STORE } from '@/lib/agent/procurement'

/**
 * GET /api/v1/agent/procurement (S3.1) — the buyer's assistant state: whether they enabled it (their web grant carries
 * the procurement scopes), whether WhatsApp is widened, and their sessions (read under their own session — RLS). 404
 * unless AGENT_ENABLED + agents_enabled.procurement + cohort.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const ctx = await procurementRouteContext('GET /agent/procurement')
  if (ctx.error) return ctx.error
  return NextResponse.json(await procurementStateView(ctx.admin, ctx.supabase, ctx.userId), { headers: PROCUREMENT_NO_STORE })
}
