import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { actOnTicket, getTicket, ticketRef } from '@/lib/support/tickets'

/**
 * GET   /api/v1/agent/admin/support/tickets/[id] — the ticket, the masked transcript, the linked subject. A WhatsApp
 *       transcript shows only the ticket user's own chat (since the number was bound to them, while they hold it) and
 *       every read is audit-logged (`wa_transcript_read`, ADR-030 §6).
 * PATCH … { action: acknowledge | assign | resolve, note? } — the human's decision (audit-logged); resolve
 *       re-enables the agent on that conversation / thread and tells the user. Never a delegated token.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'private, no-store' }
const patchSchema = z.object({ action: z.enum(['acknowledge', 'assign', 'resolve']), note: z.string().max(1000).optional() }).strict()

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const admin = await createAdminClient()
  const t = await getTicket(admin, id, { audit: { request, actorId: auth.userId } })
  if (!t) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ...t, ref: ticketRef(t.ticket.id) }, { headers: NO_STORE })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const delegated = await requireNotDelegated('admin/support/tickets')
  if (delegated) return delegated
  const rl = await enforce(limiters.adminMutation, `admin:${auth.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const admin = await createAdminClient()
  const r = await actOnTicket(admin, request, { id, action: parsed.data.action, adminUserId: auth.userId, note: parsed.data.note ?? null })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === 'not_found' ? 404 : r.error === 'note_required' ? 422 : 409 })
  return NextResponse.json({ ticket: r.ticket, ref: ticketRef(r.ticket.id) }, { headers: NO_STORE })
}
