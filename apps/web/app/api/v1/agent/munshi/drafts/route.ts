import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { munshiRouteContext, MUNSHI_NO_STORE } from '@/lib/agent/munshi-route'
import { listMunshiDrafts } from '@/lib/agent/munshi'

/**
 * GET /api/v1/agent/munshi/drafts[?status=all] (S2.2) — the provider's drafts.
 * Default: proposed and not expired (the ones awaiting a decision), each with
 * the exact `payload` the run proposed — the surface posts it unchanged as
 * `final` to POST /api/v1/agent/runs/[run_id]/decision with
 * input_refs { munshi_draft_id }.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const ctx = await munshiRouteContext('GET /agent/munshi/drafts')
  if (ctx.error) return ctx.error
  const status = request.nextUrl.searchParams.get('status') === 'all' ? 'all' : 'proposed'
  const drafts = await listMunshiDrafts(ctx.admin, ctx.providerId, { status, limit: 50 })
  return NextResponse.json({ drafts }, { headers: MUNSHI_NO_STORE })
}
