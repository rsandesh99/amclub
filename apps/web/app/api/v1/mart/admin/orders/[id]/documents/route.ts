import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { martApiGate } from '@/lib/mart/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { draftDocuments } from '@/lib/mart/documents-agent'
import { recordAiDecision } from '@/lib/mart/events'

export const dynamic = 'force-dynamic'

/** Documents Agent v1 — GET drafts, POST confirms (proposed vs final → ai_decisions). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = martApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const { id } = await params
  const admin = await createAdminClient()
  const draft = await draftDocuments(admin, id)
  if (!draft) return NextResponse.json({ error: 'Not a goods order' }, { status: 404 })
  return NextResponse.json({ draft }, { headers: { 'Cache-Control': 'private, no-store' } })
}

const confirmSchema = z.object({
  final: z.record(z.string(), z.unknown()),
  note: z.string().trim().max(500).optional(),
})

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = martApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const rl = await enforce(limiters.adminMutation, `admin:${auth.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const { id } = await params
  const parsed = confirmSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const admin = await createAdminClient()
  const draft = await draftDocuments(admin, id)
  if (!draft) return NextResponse.json({ error: 'Not a goods order' }, { status: 404 })
  const proposed = Object.fromEntries(Object.entries(draft).filter(([k]) => !['order_id', 'order_number', 'warnings'].includes(k)))
  const decisionId = await recordAiDecision(admin, auth.userId, {
    feature: 'documents_draft',
    input_refs: { order_id: id, order_number: draft.order_number, ...(parsed.data.note ? { note: parsed.data.note } : {}) },
    proposed,
    final: parsed.data.final,
  })
  await admin.from('order_events').insert({ order_id: id, actor_id: auth.userId, event: 'documents_confirmed', payload: { ai_decision_id: decisionId, eway_required: draft.eway_bill.required } })
  return NextResponse.json({ ok: true, decisionId })
}
