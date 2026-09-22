import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { munshiRouteContext, MUNSHI_NO_STORE } from '@/lib/agent/munshi-route'
import { pauseMunshi } from '@/lib/agent/munshi'

/** POST /api/v1/agent/munshi/pause { hours } (S2.2) — no scans until paused_until; drafts already proposed stay decidable. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({ hours: z.number().int().min(1).max(168).default(24) })

export async function POST(request: NextRequest) {
  const ctx = await munshiRouteContext('POST /agent/munshi/pause')
  if (ctx.error) return ctx.error
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const paused_until = await pauseMunshi(ctx.admin, { userId: ctx.userId, providerId: ctx.providerId, hours: parsed.data.hours })
  return NextResponse.json({ ok: true, paused_until }, { headers: MUNSHI_NO_STORE })
}
