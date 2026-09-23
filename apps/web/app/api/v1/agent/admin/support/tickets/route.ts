import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { extractRuntimeCredential, verifyRuntimeCredential } from '@amclub/agent-core'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { env } from '@/lib/env'
import { listTickets, openTicket, ticketRef } from '@/lib/support/tickets'

/**
 * GET  /api/v1/agent/admin/support/tickets[?status=all] — the queue (admin).
 * POST /api/v1/agent/admin/support/tickets — the runtime opens a ticket for a
 *      WhatsApp escalation (runtime credential REQUIRED; the credential's user
 *      must be the ticket's user). One open ticket per (user, channel).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'private, no-store' }

const openSchema = z
  .object({
    user_id: z.string().uuid(),
    role: z.enum(['buyer', 'provider']),
    // S3.1 — the procurement agent escalates from WhatsApp OR the web / mobile assistant mirror; a WhatsApp ticket still needs its conversation
    channel: z.enum(['whatsapp', 'web', 'mobile']),
    conversation_id: z.string().uuid().nullable().optional(),
    locale: z.enum(['en', 'hi', 'te', 'ta']).default('en'),
    reason: z.string().min(1).max(40),
    intent: z.string().max(40).nullable().optional(),
    order_id: z.string().uuid().nullable().optional(),
    rfq_id: z.string().uuid().nullable().optional(),
    run_id: z.string().uuid().nullable().optional(),
    transcript: z.array(z.object({ id: z.string().max(80), role: z.enum(['user', 'assistant']), text: z.string().max(2000) })).max(12),
    facts: z.object({ order: z.object({ order_number: z.string(), status: z.string(), amount: z.string() }).nullable().optional(), rfq: z.object({ title: z.string(), status: z.string(), quote_count: z.number().int() }).nullable().optional() }).optional(),
  })
  .strict()
  .refine((d) => d.channel !== 'whatsapp' || !!d.conversation_id, { message: 'a WhatsApp ticket needs its conversation', path: ['conversation_id'] })

export async function GET(request: NextRequest) {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const admin = await createAdminClient()
  const status = request.nextUrl.searchParams.get('status') === 'all' ? 'all' : 'open'
  const tickets = await listTickets(admin, status)
  return NextResponse.json({ tickets: tickets.map((t) => ({ ...t, ref: ticketRef(t.id) })) }, { headers: NO_STORE })
}

export async function POST(request: NextRequest) {
  const gate = agentApiGate()
  if (gate) return gate
  const secret = env.AGENT_RUNTIME_SECRET
  if (!secret) return NextResponse.json({ error: 'agent_not_configured' }, { status: 503 })
  const cred = extractRuntimeCredential(request.headers.get('authorization'))
  const claims = cred ? verifyRuntimeCredential(secret, cred) : null
  if (!claims) return NextResponse.json({ error: 'invalid_runtime_credential' }, { status: 401 })
  const parsed = openSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  if (claims.userId !== parsed.data.user_id) return NextResponse.json({ error: 'user_mismatch' }, { status: 403 })
  const admin = await createAdminClient()
  const d = parsed.data
  const { ticket, created } = await openTicket(admin, { userId: d.user_id, role: d.role, channel: d.channel, locale: d.locale, conversationId: d.conversation_id ?? null, orderId: d.order_id ?? null, rfqId: d.rfq_id ?? null, intent: d.intent ?? null, reason: d.reason, transcript: d.transcript, facts: { order: d.facts?.order ?? null, rfq: d.facts?.rfq ?? null }, runId: d.run_id ?? null })
  return NextResponse.json({ ticket_id: ticket.id, ticket_ref: ticketRef(ticket.id), created }, { status: created ? 201 : 200, headers: NO_STORE })
}
