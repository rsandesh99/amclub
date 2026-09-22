import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { renderSupportReply, toSupportLocale, type SupportIntent } from '@amclub/shared'
import { runSupportTurn, stubSupportIntent, supportIntentSchema } from '@amclub/agent-core'
import { agentApiGate } from '@/lib/agent/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { boundedChatJson } from '@/lib/agent/bounded'
import { captureServerEvent } from '@/lib/analytics/server'
import { getSupportSettings, isSupportEnabledFor, SUPPORT_CONTACT_LINE, SUPPORT_SLA } from '@/lib/support/settings'
import { webSupportLookups } from '@/lib/support/lookups'
import { getOrCreateThread, getOpenTicketForThread, listThreadMessages, openTicket, storeMessage, ticketRef, updateThreadHistory } from '@/lib/support/tickets'

/**
 * POST /api/v1/agent/support/message (S2.3) — one bounded chat turn in the
 * user's OWN session: the classifier is the only model call; the reply is a
 * template filled from RLS reads (`webSupportLookups`); an offered action is
 * returned for the UI's confirm button (which calls the spine nudge route
 * directly with `support_message_id` → ai_decisions support_nudge); an
 * escalation opens a ticket and the agent goes quiet on this thread.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const bodySchema = z.object({ text: z.string().min(1).max(1000), thread_id: z.string().uuid().optional(), locale: z.string().max(10).optional() }).strict()

export async function POST(request: NextRequest) {
  const gate = agentApiGate()
  if (gate) return gate
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('POST /agent/support/message')
  if (delegated) return delegated
  const admin = await createAdminClient()
  if (!(await isSupportEnabledFor(admin, userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const rl = await enforce(limiters.supportChat, `support:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const rlh = await enforce(limiters.supportChatHourly, `support-h:${userId}`)
  if (!rlh.ok) return tooManyRequests(rlh.retryAfter)
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const actor = await resolveActor(admin, userId)
  const roles: ('buyer' | 'provider')[] = [...(actor.msmeId ? ['buyer' as const] : []), ...(actor.providerId ? ['provider' as const] : [])]
  if (!roles.length) return NextResponse.json({ error: 'no_profile' }, { status: 403 })
  const locale = toSupportLocale(parsed.data.locale ?? request.headers.get('x-amc-locale'))
  const surface = request.headers.get('x-amc-surface') === 'mobile' ? 'mobile' : 'web'
  const thread = await getOrCreateThread(admin, { userId, role: roles[0]!, locale, threadId: parsed.data.thread_id ?? null })
  const settings = await getSupportSettings(admin)
  const userMsg = await storeMessage(admin, { threadId: thread.id, role: 'user', body: parsed.data.text })

  // An open ticket: store only; the escalated_open template; NO model call.
  const open = thread.open_ticket_id ? await getOpenTicketForThread(admin, thread.id) : null
  if (open) {
    const text = renderSupportReply('escalated_open', { sla_hours: SUPPORT_SLA.acknowledge_hours, ticket_ref: ticketRef(open.id), contact: SUPPORT_CONTACT_LINE }, locale)
    await storeMessage(admin, { threadId: thread.id, role: 'assistant', body: text, replyKey: 'escalated_open' })
    captureServerEvent(userId, 'support_turn', { channel: surface, intent: null, escalated: true, reply_key: 'escalated_open', ticket_open: true })
    return NextResponse.json({ thread_id: thread.id, reply: { key: 'escalated_open', text }, ticket_ref: ticketRef(open.id) }, { headers: NO_STORE })
  }

  const history = await listThreadMessages(admin, thread.id, 12)
  const previous = history.filter((m) => m.role === 'user' && m.id !== userMsg.id).at(-1) ?? null
  const lookups = webSupportLookups({ session: supabase, admin, userId, msmeId: actor.msmeId, providerId: actor.providerId })
  const turn = await runSupportTurn(
    {
      classify: async (parts) => {
        const res = await boundedChatJson(admin, {
          userId,
          feature: 'support',
          taskClass: 'support_intent',
          promptId: 'support_intent',
          promptVersion: 'v1',
          schema: supportIntentSchema,
          parts,
          temperature: 0,
          stub: () => stubSupportIntent(parsed.data.text, locale, (parts.trusted ?? []).flatMap((l) => (l.startsWith('order_numbers: ') ? l.slice(15).split(' | ') : []))),
          meta: { thread_id: thread.id, surface },
        })
        return res.data
      },
      lookups,
      settings: { escalateAfterTurns: settings.escalateAfterTurns, nudgeCooldownHours: settings.nudgeCooldownHours },
      sla: SUPPORT_SLA,
      supportContact: SUPPORT_CONTACT_LINE,
    },
    { text: parsed.data.text, messageId: userMsg.id, channel: 'support_chat', roles, locale, history: { intents: thread.last_intents ?? [], unclearStreak: thread.unclear_streak ?? 0, previousText: previous?.body ?? null, previousMessageId: previous?.id ?? null }, openTicket: false },
  )
  if (!turn.numbers.ok) console.error('[support] numbers rule violated', turn.reply.key, turn.numbers.missing)

  let replyText = turn.reply.text
  let replyKey = turn.reply.key
  let ticketRefOut: string | null = null
  if (turn.escalate) {
    const transcript = [...history.filter((m) => m.id !== userMsg.id).slice(-5).map((m) => ({ id: m.id, role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant', text: m.body })), { id: userMsg.id, role: 'user' as const, text: parsed.data.text }]
    let facts: Parameters<typeof openTicket>[1]['facts'] = {}
    if (turn.lookupRefs.order_id) {
      const listed = (await lookups.listOrders(turn.role).catch(() => [])).find((x) => x.id === turn.lookupRefs.order_id)
      if (listed) facts = { order: { order_number: listed.order_number, status: listed.status, amount: listed.amount } }
    }
    if (turn.lookupRefs.rfq_id) {
      const r = (await lookups.listRfqs(turn.role).catch(() => [])).find((x) => x.id === turn.lookupRefs.rfq_id)
      if (r) facts = { ...facts, rfq: { title: r.title, status: r.status, quote_count: r.quote_count } }
    }
    const { ticket } = await openTicket(admin, { userId, role: turn.role, channel: surface, locale, threadId: thread.id, orderId: turn.lookupRefs.order_id ?? null, rfqId: turn.lookupRefs.rfq_id ?? null, intent: turn.intent?.intent ?? null, reason: turn.escalate.reason, transcript, facts })
    ticketRefOut = ticketRef(ticket.id)
    replyKey = 'escalated'
    replyText = renderSupportReply('escalated', { ...turn.reply.slots, ticket_ref: ticketRefOut }, locale)
  }
  const assistant = await storeMessage(admin, { threadId: thread.id, role: 'assistant', body: replyText, intent: turn.intent?.intent ?? null, replyKey, lookupRefs: turn.lookupRefs })
  await updateThreadHistory(admin, thread.id, { intents: [...(thread.last_intents ?? []), (turn.intent?.intent ?? 'other') as SupportIntent], unclearStreak: turn.escalate ? 0 : turn.unclearStreak, locale })
  captureServerEvent(userId, 'support_turn', { channel: surface, intent: turn.intent?.intent ?? null, escalated: !!turn.escalate, reply_key: replyKey, role: turn.role })
  return NextResponse.json(
    {
      thread_id: thread.id,
      reply: { key: replyKey, text: replyText },
      ...(turn.action ? { action: { tool: turn.action.tool, subject: turn.action.subject, support_message_id: assistant.id } } : {}),
      ...(ticketRefOut ? { ticket_ref: ticketRefOut } : {}),
    },
    { headers: NO_STORE },
  )
}
