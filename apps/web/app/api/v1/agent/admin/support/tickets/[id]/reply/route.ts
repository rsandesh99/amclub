import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { waOpsReplySchema } from '@amclub/shared'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { opsReplyToTicket } from '@/lib/support/tickets'
import { serverError } from '@/lib/api/errors'

/**
 * POST /api/v1/agent/admin/support/tickets/[id]/reply { text, clickId } (ADR-030 §6) — a person answers the ticket.
 * WhatsApp: free text inside the user's 24-hour window, else the approved support_reply template (title = the ticket
 * ref, body = the text), through the one send path; only while the user still holds the number (409 number_changed).
 * Web / mobile: the reply joins the chat thread and the user gets an in-app notice. Audit-logged. Never a delegated
 * token (admin actions are never agent tools).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const delegated = await requireNotDelegated('admin/support/tickets/reply')
  if (delegated) return delegated
  const rl = await enforce(limiters.adminMutation, `admin:${auth.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const parsed = waOpsReplySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  try {
    const admin = await createAdminClient()
    const r = await opsReplyToTicket(admin, request, { id, adminUserId: auth.userId, text: parsed.data.text, clickId: parsed.data.clickId })
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === 'not_found' ? 404 : 409, headers: NO_STORE })
    return NextResponse.json({ channel: r.channel, outcome: r.outcome, reason: r.reason, usedTemplate: r.usedTemplate, messageId: r.messageId }, { headers: NO_STORE })
  } catch (e) {
    return serverError('[admin/support/tickets/reply]', e)
  }
}
