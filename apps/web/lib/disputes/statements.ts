import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DisputeParty, DisputeStatementView } from '@amclub/shared'
import { resolveActor } from '@/lib/orders/actor'

/**
 * Party statements (S1.7, spine). One statement per party on an open dispute,
 * stored AFTER redactContactInfo; readable by both parties and admin. The
 * routes write with the service role after the party check below.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DisputeParty_ {
  role: DisputeParty
  order: { id: string; msme_id: string; provider_id: string; status: string; source: string | null; quote_id: string | null; order_number: string; kind: string }
  dispute: { id: string; status: string; triage_id: string | null; reason: string; created_at: string } | null
}

/** The caller's side of the order (buyer = msme party, provider = provider party) + the dispute. */
export async function partyForOrder(admin: SupabaseClient, orderId: string, userId: string): Promise<DisputeParty_ | { role: null; status: 404 | 403 }> {
  const actor = await resolveActor(admin, userId)
  const { data: order } = await admin.from('orders').select('id, msme_id, provider_id, status, source, quote_id, order_number, kind').eq('id', orderId).maybeSingle()
  if (!order) return { role: null, status: 404 }
  const o = order as any
  const role: DisputeParty | null = actor.msmeId && o.msme_id === actor.msmeId ? 'buyer' : actor.providerId && o.provider_id === actor.providerId ? 'provider' : null
  if (!role) return { role: null, status: 403 }
  const { data: dispute } = await admin.from('disputes').select('id, status, triage_id, reason, created_at').eq('order_id', orderId).maybeSingle()
  return { role, order: o, dispute: (dispute as any) ?? null }
}

const COLS = 'id, role, body, redacted, document_ids, created_at, updated_at'

export async function listStatements(admin: SupabaseClient, disputeId: string): Promise<DisputeStatementView[]> {
  const { data, error } = await admin.from('dispute_statements').select(COLS).eq('dispute_id', disputeId).is('deleted_at', null).order('created_at', { ascending: true })
  if (error) {
    console.error('[statements] list', error.message)
    return []
  }
  return ((data ?? []) as any[]).map((s) => ({ ...s, document_ids: s.document_ids ?? [] }))
}

export interface ThreadMessageView {
  id: string
  sender_role: 'buyer' | 'provider' | 'unknown'
  body: string
  redacted: boolean
  created_at: string
}

/** The pre-payment quote thread (masked bodies) when the order came from a quote; [] otherwise. */
export async function loadQuoteThread(admin: SupabaseClient, order: { source: string | null; quote_id: string | null; msme_id: string; provider_id: string }): Promise<ThreadMessageView[]> {
  if (order.source !== 'quote' || !order.quote_id) return []
  const { data: convo } = await admin.from('conversations').select('id').eq('context_type', 'quote').eq('context_id', order.quote_id).maybeSingle()
  if (!convo) return []
  const [{ data: messages }, { data: m }, { data: p }] = await Promise.all([
    admin.from('messages').select('id, sender_id, body, redacted, created_at').eq('conversation_id', (convo as any).id).order('created_at', { ascending: true }),
    admin.from('msme_profiles').select('user_id').eq('id', order.msme_id).maybeSingle(),
    admin.from('provider_profiles').select('user_id').eq('id', order.provider_id).maybeSingle(),
  ])
  const buyerUid = (m as any)?.user_id ?? null
  const providerUid = (p as any)?.user_id ?? null
  return ((messages ?? []) as any[]).map((x) => ({
    id: x.id,
    sender_role: x.sender_id === buyerUid ? 'buyer' : x.sender_id === providerUid ? 'provider' : 'unknown',
    body: x.body,
    redacted: x.redacted === true,
    created_at: x.created_at,
  }))
}
/* eslint-enable @typescript-eslint/no-explicit-any */
