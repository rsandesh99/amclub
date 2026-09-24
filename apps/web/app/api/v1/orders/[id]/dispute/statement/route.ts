import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { disputeStatementSchema, redactContactInfo } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { addEvent } from '@/lib/orders/transitions'
import { listStatements, partyForOrder } from '@/lib/disputes/statements'
import { notifyDisputeStatement } from '@/lib/notifications/events'
import { maybeEnqueueDisputeTriage } from '@/lib/agent/triage-trigger'
import { captureServerEvent } from '@/lib/analytics/server'
import { serverError } from '@/lib/api/errors'
import { requireNotDelegated } from '@/lib/agent/scope'

/**
 * /api/v1/orders/[id]/dispute/statement (S1.7, SPINE — not flag-gated).
 *  GET   both statements (redacted bodies) — parties.
 *  POST  the caller's ONE statement on an open dispute (contact-masked; ≤ 5 of
 *        this order's documents); 409 statement_exists on a second POST.
 *  PATCH edit the body while the dispute is open AND no triage exists yet
 *        (409 triage_exists after — the card and the statements never diverge).
 * Writes an order_events row (`dispute_statement`), notifies the counter-party
 * (+ the ops user in-app when set) and, after the SECOND party's statement,
 * asks for a re-triage (gated; a no-op while dark).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/* eslint-disable @typescript-eslint/no-explicit-any */
async function load(orderId: string) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = await createAdminClient()
  const party = await partyForOrder(admin, orderId, userId)
  if (!party.role) return { error: NextResponse.json({ error: party.status === 404 ? 'Not found' : 'Forbidden' }, { status: party.status }) }
  return { userId, admin, party }
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await load(id)
  if ('error' in ctx) return ctx.error
  if (!ctx.party.dispute) return NextResponse.json({ statements: [], role: ctx.party.role, editable: false }, { headers: NO_STORE })
  const statements = await listStatements(ctx.admin, ctx.party.dispute.id)
  const editable = ctx.party.order.status === 'disputed' && ctx.party.dispute.status === 'open' && !ctx.party.dispute.triage_id
  return NextResponse.json({ statements, role: ctx.party.role, editable, triageExists: !!ctx.party.dispute.triage_id }, { headers: NO_STORE })
}

async function write(request: NextRequest, orderId: string, mode: 'create' | 'edit') {
  // Audit M8 — a party's own statement: no agent tool wraps it, so a delegated token is refused.
  const delegated = await requireNotDelegated(`${mode === 'create' ? 'POST' : 'PATCH'} /orders/[id]/dispute/statement`)
  if (delegated) return delegated
  const ctx = await load(orderId)
  if ('error' in ctx) return ctx.error
  const { admin, userId, party } = ctx
  const rl = await enforce(limiters.authed, `dispute-statement:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  if (party.order.status !== 'disputed' || !party.dispute || party.dispute.status !== 'open') {
    return NextResponse.json({ error: 'dispute_not_open' }, { status: 409 })
  }
  const parsed = disputeStatementSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data
  if (d.document_ids.length) {
    const { data: docs } = await admin.from('order_documents').select('id').eq('order_id', orderId).in('id', d.document_ids)
    if ((docs ?? []).length !== new Set(d.document_ids).size) return NextResponse.json({ error: 'document_not_on_order' }, { status: 422 })
  }
  const masked = redactContactInfo(d.body)
  const { data: existing } = await admin.from('dispute_statements').select('id').eq('dispute_id', party.dispute.id).eq('role', party.role).is('deleted_at', null).maybeSingle()

  let statementId: string
  if (mode === 'create') {
    if (existing) return NextResponse.json({ error: 'statement_exists', statement_id: (existing as any).id }, { status: 409 })
    const { data: ins, error } = await admin
      .from('dispute_statements')
      .insert({ dispute_id: party.dispute.id, order_id: orderId, author_user_id: userId, role: party.role, body: masked.text, redacted: masked.redacted, document_ids: d.document_ids })
      .select('id')
      .single()
    if (error || !ins) {
      if ((error as any)?.code === '23505') return NextResponse.json({ error: 'statement_exists' }, { status: 409 })
      return serverError('[dispute statement POST]', error)
    }
    statementId = (ins as any).id
  } else {
    if (!existing) return NextResponse.json({ error: 'statement_missing' }, { status: 404 })
    if (party.dispute.triage_id) return NextResponse.json({ error: 'triage_exists' }, { status: 409 })
    const { error } = await admin
      .from('dispute_statements')
      .update({ body: masked.text, redacted: masked.redacted, document_ids: d.document_ids })
      .eq('id', (existing as any).id)
    if (error) return serverError('[dispute statement PATCH]', error)
    statementId = (existing as any).id
  }

  await addEvent(admin, orderId, 'dispute_statement', userId, { statement_id: statementId, role: party.role, edited: mode === 'edit' })
  try {
    await notifyDisputeStatement(admin, { order: party.order, disputeId: party.dispute.id, role: party.role, edited: mode === 'edit' })
  } catch (e) {
    console.error('[dispute statement notify]', (e as Error).message)
  }
  captureServerEvent(userId, 'dispute_statement_submitted', { order_id: orderId, dispute_id: party.dispute.id, role: party.role, has_docs: d.document_ids.length > 0, redacted: masked.redacted, edited: mode === 'edit' })

  // Re-triage once BOTH sides are on record (first statement of the second party). Dark ⇒ no-op.
  let triage: { enqueued: boolean; reason?: string } = { enqueued: false, reason: 'not_second_statement' }
  if (mode === 'create') {
    const all = await listStatements(admin, party.dispute.id)
    if (all.length >= 2) triage = await maybeEnqueueDisputeTriage(admin, { orderId, disputeId: party.dispute.id })
  }
  const statements = await listStatements(admin, party.dispute.id)
  return NextResponse.json({ statement_id: statementId, redacted: masked.redacted, statements, retriage: triage }, { status: mode === 'create' ? 201 : 200, headers: NO_STORE })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return write(request, id, 'create')
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return write(request, id, 'edit')
}
/* eslint-enable @typescript-eslint/no-explicit-any */
