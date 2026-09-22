import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { MUNSHI_CONSENT_TEXT_VERSION } from '@amclub/shared'
import { munshiRouteContext, MUNSHI_NO_STORE } from '@/lib/agent/munshi-route'
import { enableMunshi, munshiStateView } from '@/lib/agent/munshi'
import { clientIp, enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

/**
 * POST /api/v1/agent/munshi/enable (S2.2) — the provider's consent: creates /
 * refreshes the web grant (persona provider, MUNSHI_SCOPES) with a consent
 * snapshot, widens an existing WhatsApp grant to the same scopes (one consent
 * screen, two channels), and clears any pause. 404 unless the agent is
 * enabled for this user.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({ locale: z.string().min(2).max(10).optional(), consent_text_version: z.literal(MUNSHI_CONSENT_TEXT_VERSION) }).strict()

export async function POST(request: NextRequest) {
  const ctx = await munshiRouteContext('POST /agent/munshi/enable')
  if (ctx.error) return ctx.error
  const rl = await enforce(limiters.authed, `munshi-switch:${ctx.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const result = await enableMunshi(ctx.admin, { userId: ctx.userId, providerId: ctx.providerId, locale: parsed.data.locale ?? 'en', ip: clientIp(request), userAgent: request.headers.get('user-agent') })
  if (!result.webGrantId) return NextResponse.json({ error: 'grant_failed' }, { status: 500 })
  const state = await munshiStateView(ctx.admin, { userId: ctx.userId, providerId: ctx.providerId })
  return NextResponse.json({ ...state, whatsapp_widened: result.whatsappWidened }, { status: 201, headers: MUNSHI_NO_STORE })
}
