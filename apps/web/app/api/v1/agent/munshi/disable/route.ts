import { NextResponse } from 'next/server'
import { munshiRouteContext, MUNSHI_NO_STORE } from '@/lib/agent/munshi-route'
import { disableMunshi, munshiStateView } from '@/lib/agent/munshi'

/** POST /api/v1/agent/munshi/disable (S2.2) — revoke the web grant; the WhatsApp grant keeps its channel with scopes []. Drafts stay readable. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const ctx = await munshiRouteContext('POST /agent/munshi/disable')
  if (ctx.error) return ctx.error
  await disableMunshi(ctx.admin, { userId: ctx.userId, providerId: ctx.providerId })
  return NextResponse.json(await munshiStateView(ctx.admin, { userId: ctx.userId, providerId: ctx.providerId }), { headers: MUNSHI_NO_STORE })
}
