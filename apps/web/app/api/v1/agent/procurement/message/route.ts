import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { procurementGrants, procurementRouteContext, storeComposerTurn, PROCUREMENT_NO_STORE } from '@/lib/agent/procurement'
import { enqueueRuntimeJob } from '@/lib/agent/runtime-client'
import { hasProcurementScopes } from '@amclub/shared'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { captureServerEvent } from '@/lib/analytics/server'

/**
 * POST /api/v1/agent/procurement/message (S3.1) — the web / mobile composer. Stores the buyer's turn (contact-masked)
 * in their active session (or a fresh web session) and asks the runtime to run the SAME `procurement.turn` engine as
 * WhatsApp — one engine, two surfaces. A label tap (`label`, the quote letter) or the "new request / this one" tap
 * (`session_choice` + the `message_id` of the turn it answers) are the buyer's taps, passed as such (never read by a
 * model). The reply appears in the thread (the page polls). Requires the buyer's own grant (enable first).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z
  .object({
    session_id: z.string().uuid().nullable().optional(),
    text: z.string().trim().min(1).max(1000).optional(),
    label: z.string().regex(/^[A-G]$/).optional(),
    session_choice: z.enum(['new', 'current']).optional(),
    message_id: z.string().uuid().optional(),
    surface: z.enum(['web', 'mobile']).optional(),
  })
  .strict()
  .refine((d) => [d.text, d.label, d.session_choice].filter((x) => x !== undefined).length === 1, { message: 'exactly one of text / label / session_choice' })
  .refine((d) => (!d.label && !d.session_choice) || !!d.session_id, { message: 'a tap needs its session', path: ['session_id'] })
  .refine((d) => !d.session_choice || !!d.message_id, { message: 'a session choice needs the message it answers', path: ['message_id'] })

export async function POST(request: NextRequest) {
  const ctx = await procurementRouteContext('POST /agent/procurement/message')
  if (ctx.error) return ctx.error
  const burst = await enforce(limiters.procurementChat, `pc:${ctx.userId}`)
  if (!burst.ok) return tooManyRequests(burst.retryAfter)
  const hourly = await enforce(limiters.procurementChatHourly, `pch:${ctx.userId}`)
  if (!hourly.ok) return tooManyRequests(hourly.retryAfter)
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data
  const g = await procurementGrants(ctx.admin, ctx.userId)
  if (!g.web || !hasProcurementScopes(g.web.scopes)) return NextResponse.json({ error: 'not_enabled' }, { status: 409 })
  const locale = request.headers.get('x-amc-locale') ?? 'en'
  const surface = d.surface ?? 'web'

  // a session choice re-runs the buyer's ORIGINAL turn (their own, in their own session)
  if (d.session_choice) {
    const { data: t } = await ctx.admin.from('procurement_turns').select('id, user_id, session_id, role').eq('id', d.message_id!).maybeSingle()
    if (!t || (t as { user_id: string }).user_id !== ctx.userId || (t as { role: string }).role !== 'user') return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const job = await enqueueRuntimeJob('procurement.turn', { userId: ctx.userId, surface, sessionId: d.session_id, turnId: d.message_id, forced: { sessionChoice: d.session_choice } }, { userId: ctx.userId, persona: 'buyer' })
    return NextResponse.json({ session_id: d.session_id, turn_id: d.message_id, enqueued: job.ok, ...(job.ok ? {} : { reason: job.reason ?? null }) }, { status: 202, headers: PROCUREMENT_NO_STORE })
  }

  const stored = await storeComposerTurn(ctx.admin, { userId: ctx.userId, msmeId: ctx.msmeId, sessionId: d.session_id ?? null, text: d.text ?? `${d.label}`, surface, locale })
  if ('error' in stored) return NextResponse.json({ error: stored.error }, { status: stored.status })
  const job = await enqueueRuntimeJob('procurement.turn', { userId: ctx.userId, surface, sessionId: stored.sessionId, turnId: stored.turnId, ...(d.label ? { forced: { label: d.label } } : {}) }, { userId: ctx.userId, persona: 'buyer' })
  captureServerEvent(ctx.userId, 'procurement_message', { surface, kind: d.label ? 'label' : 'text', enqueued: job.ok })
  return NextResponse.json({ session_id: stored.sessionId, turn_id: stored.turnId, enqueued: job.ok, ...(job.ok ? {} : { reason: job.reason ?? null }) }, { status: 202, headers: PROCUREMENT_NO_STORE })
}
