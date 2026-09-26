import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { toSupportLocale, waPreview } from '@amclub/shared'
import { adminMutation, isUuid, NO_STORE } from '@/lib/privacy/route-guard'
import { phoneDigits } from '@/lib/privacy/common'
import { openTicket, ticketRef } from '@/lib/support/tickets'
import { writeAudit } from '@/lib/audit/log'
import { serverError } from '@/lib/api/errors'

/**
 * POST /api/v1/admin/whatsapp/unrouted/[id]/ticket (ADR-030 §6) — "Open ticket" for an unrouted number. A support ticket
 * belongs to an account, so this works only when an AMClub account holds the number now (users.phone): otherwise 409
 * no_account (reply in the window, or ask them to sign up). The ordinary openTicket path runs (one open ticket per
 * user and channel; the agent stays quiet on the conversation until a person resolves it). Audit-logged.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await adminMutation('POST /admin/whatsapp/unrouted/[id]/ticket')
  if (g.error) return g.error
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const { data: conv } = await g.admin.from('wa_conversations').select('id, phone_e164, locale').eq('id', id).maybeSingle()
    const c = conv as { id: string; phone_e164: string; locale: string | null } | null
    if (!c) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const d = phoneDigits(c.phone_e164)
    const { data: holder } = await g.admin.from('users').select('id, roles').in('phone', [`+${d}`, d]).limit(1).maybeSingle()
    const u = holder as { id: string; roles: string[] | null } | null
    if (!u) return NextResponse.json({ error: 'no_account' }, { status: 409, headers: NO_STORE })
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const { data: msgs } = await g.admin.from('wa_messages').select('id, body').eq('conversation_id', c.id).eq('direction', 'in').gte('created_at', since).order('created_at', { ascending: false }).limit(6)
    const transcript = ((msgs ?? []) as { id: string; body: string | null }[]).reverse().filter((m) => m.body).map((m) => ({ id: m.id, role: 'user' as const, text: waPreview(m.body, 2000) }))
    const { ticket, created } = await openTicket(g.admin, {
      userId: u.id,
      role: (u.roles ?? []).includes('provider') ? 'provider' : 'buyer',
      channel: 'whatsapp',
      locale: toSupportLocale(c.locale),
      conversationId: c.id,
      reason: 'ops_opened',
      transcript,
    })
    await writeAudit(g.admin, request, { actorId: g.userId, action: 'wa_ticket_open', entity: 'support_tickets', entityId: ticket.id, before: null, after: { created, conversation_id: c.id, user_id: u.id } })
    return NextResponse.json({ ticketId: ticket.id, ref: ticketRef(ticket.id), created }, { status: created ? 201 : 200, headers: NO_STORE })
  } catch (e) {
    return serverError('[admin/whatsapp/unrouted/ticket]', e)
  }
}
