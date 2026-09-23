import { NextResponse } from 'next/server'
import { toSupportLocale } from '@amclub/shared'
import { agentApiGate } from '@/lib/agent/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { isSupportEnabledFor } from '@/lib/support/settings'
import { getOpenTicketForThread, getOrCreateThread, listThreadMessages, ticketRef } from '@/lib/support/tickets'

/** GET /api/v1/agent/support/thread (S2.3) — the user's chat thread (last 50 messages; user text masked) + the open ticket ref. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const gate = agentApiGate()
  if (gate) return gate
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = await createAdminClient()
  if (!(await isSupportEnabledFor(admin, userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const actor = await resolveActor(admin, userId)
  const role: 'buyer' | 'provider' = actor.msmeId ? 'buyer' : 'provider'
  if (!actor.msmeId && !actor.providerId) return NextResponse.json({ error: 'no_profile' }, { status: 403 })
  const thread = await getOrCreateThread(admin, { userId, role, locale: toSupportLocale(null) })
  const [messages, open] = await Promise.all([listThreadMessages(admin, thread.id, 50), thread.open_ticket_id ? getOpenTicketForThread(admin, thread.id) : Promise.resolve(null)])
  return NextResponse.json({ thread_id: thread.id, messages, ticket_ref: open ? ticketRef(open.id) : null }, { headers: { 'Cache-Control': 'private, no-store' } })
}
