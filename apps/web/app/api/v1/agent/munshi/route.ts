import { NextResponse } from 'next/server'
import { munshiRouteContext, MUNSHI_NO_STORE } from '@/lib/agent/munshi-route'
import { munshiStateView } from '@/lib/agent/munshi'

/** GET /api/v1/agent/munshi (S2.2) — the partner tab's state: enabled, grants, pause, drafts awaiting, this week, price-book size. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const ctx = await munshiRouteContext('GET /agent/munshi')
  if (ctx.error) return ctx.error
  return NextResponse.json(await munshiStateView(ctx.admin, { userId: ctx.userId, providerId: ctx.providerId }), { headers: MUNSHI_NO_STORE })
}
