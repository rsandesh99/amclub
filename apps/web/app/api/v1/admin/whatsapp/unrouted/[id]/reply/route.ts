import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { waOpsReplySchema } from '@amclub/shared'
import { adminMutation, isUuid, NO_STORE } from '@/lib/privacy/route-guard'
import { sendOpsWhatsApp, windowOpen } from '@/lib/whatsapp/admin'
import { writeAudit } from '@/lib/audit/log'
import { captureServerEvent } from '@/lib/analytics/server'
import { serverError } from '@/lib/api/errors'

/**
 * POST /api/v1/admin/whatsapp/unrouted/[id]/reply { text, clickId } (ADR-030 §6) — ops answer a number with no bound
 * account, free text, only inside the person's 24-hour window (a direct reply to their own message: it needs only "not
 * STOPped"). Outside the window → 409 outside_window (nothing is sent). One click is one message (the idempotency key
 * carries the click id). Sent through sendWhatsApp like every other message; audit-logged without the text.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await adminMutation('POST /admin/whatsapp/unrouted/[id]/reply')
  if (g.error) return g.error
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const parsed = waOpsReplySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  try {
    const { data: conv } = await g.admin.from('wa_conversations').select('id, phone_e164, user_id, window_open_until').eq('id', id).maybeSingle()
    const c = conv as { id: string; phone_e164: string; user_id: string | null; window_open_until: string | null } | null
    if (!c) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!windowOpen(c.window_open_until)) return NextResponse.json({ error: 'outside_window', windowUntil: c.window_open_until }, { status: 409, headers: NO_STORE })
    const res = await sendOpsWhatsApp(g.admin, {
      phoneE164: c.phone_e164,
      userId: c.user_id,
      conversationId: c.id,
      purpose: 'transactional',
      initiation: 'reply',
      kind: 'ops_reply',
      body: { type: 'text', text: parsed.data.text },
      idempotencyKey: `ops_reply:${c.id}:${parsed.data.clickId}`,
      meta: { ops_user_id: g.userId },
    })
    await writeAudit(g.admin, request, {
      actorId: g.userId,
      action: 'wa_ops_reply',
      entity: 'wa_conversations',
      entityId: c.id,
      before: { window_open_until: c.window_open_until },
      after: { outcome: res.outcome, reason: res.reason ?? null, error_code: res.error?.code ?? null, message_id: res.messageId ?? null, chars: parsed.data.text.length },
    })
    captureServerEvent(g.userId, 'wa_ops_reply', { surface: 'unrouted', outcome: res.outcome, reason: res.reason ?? null })
    return NextResponse.json({ outcome: res.outcome, reason: res.reason ?? null, messageId: res.messageId ?? null }, { headers: NO_STORE })
  } catch (e) {
    return serverError('[admin/whatsapp/unrouted/reply]', e)
  }
}
