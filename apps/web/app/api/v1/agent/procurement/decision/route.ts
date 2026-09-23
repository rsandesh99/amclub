import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { procurementRouteContext, PROCUREMENT_NO_STORE } from '@/lib/agent/procurement'
import { enqueueRuntimeJob } from '@/lib/agent/runtime-client'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

/**
 * POST /api/v1/agent/procurement/decision (S3.1) — the buyer's web / mobile tap on a proposal card (Approve / Edit /
 * No). The run must be the OPEN proposal of one of the buyer's own active sessions. The tap goes to the runtime's
 * `procurement.decide` — the same path as a WhatsApp button: the decision route under the buyer's token (ONE
 * ai_decisions row, feature procurement_step), then the ORDINARY route. A tap is always a confirmation, including
 * for the button-only tools (choose_quote, decline_quote, the chase nudge). Checkout is never called here: an
 * approved choose_quote yields the link to the RFQ page, where the buyer's own tap pays.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({ run_id: z.string().uuid(), action: z.enum(['ok', 'edit', 'no']) }).strict()

export async function POST(request: NextRequest) {
  const ctx = await procurementRouteContext('POST /agent/procurement/decision')
  if (ctx.error) return ctx.error
  const rl = await enforce(limiters.authed, `procurement-decision:${ctx.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const { data: s } = await ctx.admin.from('procurement_sessions').select('id, user_id').eq('open_run_id', parsed.data.run_id).is('deleted_at', null).maybeSingle()
  if (!s || (s as { user_id: string }).user_id !== ctx.userId) return NextResponse.json({ error: 'proposal_gone' }, { status: 409 })
  const job = await enqueueRuntimeJob('procurement.decide', { runId: parsed.data.run_id, userId: ctx.userId, action: parsed.data.action }, { userId: ctx.userId, persona: 'buyer', runId: parsed.data.run_id })
  return NextResponse.json({ session_id: (s as { id: string }).id, enqueued: job.ok, ...(job.ok ? {} : { reason: job.reason ?? null }) }, { status: 202, headers: PROCUREMENT_NO_STORE })
}
