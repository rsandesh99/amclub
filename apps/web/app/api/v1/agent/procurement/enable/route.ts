import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { PROCUREMENT_CONSENT_TEXT_VERSION } from '@amclub/shared'
import { enableProcurement, procurementRouteContext, procurementStateView, PROCUREMENT_NO_STORE } from '@/lib/agent/procurement'
import { clientIp, enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

/**
 * POST /api/v1/agent/procurement/enable (S3.1) — the buyer's consent: creates / refreshes the web grant (persona
 * buyer, PROCUREMENT_SCOPES — never accept_quote or place_order) with a consent snapshot, and widens an existing
 * WhatsApp grant to the same scopes (one consent screen, two channels — the Munshi precedent). 404 unless enabled for
 * this user.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({ locale: z.string().min(2).max(10).optional(), consent_text_version: z.literal(PROCUREMENT_CONSENT_TEXT_VERSION) }).strict()

export async function POST(request: NextRequest) {
  const ctx = await procurementRouteContext('POST /agent/procurement/enable')
  if (ctx.error) return ctx.error
  const rl = await enforce(limiters.authed, `procurement-switch:${ctx.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const r = await enableProcurement(ctx.admin, { userId: ctx.userId, locale: parsed.data.locale ?? 'en', ip: clientIp(request), userAgent: request.headers.get('user-agent') })
  if (!r.webGrantId) return NextResponse.json({ error: 'grant_failed' }, { status: 500 })
  return NextResponse.json({ ...(await procurementStateView(ctx.admin, ctx.supabase, ctx.userId)), whatsapp_widened: r.whatsappWidened }, { status: 201, headers: PROCUREMENT_NO_STORE })
}
