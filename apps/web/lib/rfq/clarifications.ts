import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sortClarifications, type ClarificationView } from '@amclub/shared'
import { resolveActor } from '@/lib/orders/actor'
import { RFQ_GOODS_LIST_COLS, isGoodsRow } from '@/lib/mart/staged-columns'

/**
 * S1.3 — RFQ clarification threads, server side. Reads and writes go through
 * the service role AFTER the party check here; RLS (0034) additionally lets
 * the buyer and every matched provider read rows directly (mobile/PostgREST),
 * but the API is what shapes the payload: a provider NEVER receives
 * `provider_id`, only `mine`. No status, no money, no model.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ClarificationParty =
  | { role: 'buyer'; msmeId: string; rfq: RfqForClarification }
  | { role: 'provider'; providerId: string; declinedAt: string | null; rfq: RfqForClarification }

export interface RfqForClarification {
  id: string
  title: string
  status: string
  expiresAt: string
  msmeId: string
  buyerUserId: string | null
  /** For analytics only; read through the staged fragment (service while Mart is dark). */
  kind: 'service' | 'goods'
}

// Staged goods columns only through the fragment (empty while Mart is dark).
const RFQ_COLS = 'id, title, status, expires_at, msme_id' + RFQ_GOODS_LIST_COLS + ', msme:msme_profiles!inner(user_id)'

function mapRfq(r: any): RfqForClarification {
  return { id: r.id, title: r.title, status: r.status, expiresAt: r.expires_at, msmeId: r.msme_id, buyerUserId: r.msme?.user_id ?? null, kind: isGoodsRow(r) ? 'goods' : 'service' }
}

/** Who the caller is on this RFQ: its buyer, a matched provider (declined or not), or nobody (null). */
export async function resolveClarificationParty(admin: SupabaseClient, userId: string, rfqId: string): Promise<ClarificationParty | null> {
  const { data: rfqRow } = await admin.from('rfqs').select(RFQ_COLS).eq('id', rfqId).is('deleted_at', null).maybeSingle()
  if (!rfqRow) return null
  const rfq = mapRfq(rfqRow)
  const actor = await resolveActor(admin, userId)
  if (actor.msmeId && actor.msmeId === rfq.msmeId) return { role: 'buyer', msmeId: actor.msmeId, rfq }
  if (actor.providerId) {
    const { data: match } = await admin.from('rfq_matches').select('declined_at').eq('rfq_id', rfqId).eq('provider_id', actor.providerId).maybeSingle()
    if (match) return { role: 'provider', providerId: actor.providerId, declinedAt: (match as any).declined_at ?? null, rfq }
  }
  return null
}

/** The RFQ is still taking questions/answers: open|quoted and not past expires_at. */
export function rfqAcceptsClarifications(rfq: Pick<RfqForClarification, 'status' | 'expiresAt'>, now = Date.now()): boolean {
  return (rfq.status === 'open' || rfq.status === 'quoted') && new Date(rfq.expiresAt).getTime() > now
}

interface Row {
  id: string
  provider_id: string
  question: string
  question_redacted: boolean
  answer: string | null
  answer_redacted: boolean
  asked_at: string
  answered_at: string | null
  provider?: { display_name: string | null } | null
}

export function toClarificationView(row: Row, viewer: { role: 'buyer' } | { role: 'provider'; providerId: string }): ClarificationView {
  const base: ClarificationView = {
    id: row.id,
    question: row.question,
    answer: row.answer ?? null,
    askedAt: row.asked_at,
    answeredAt: row.answered_at ?? null,
    mine: viewer.role === 'provider' && row.provider_id === viewer.providerId,
    questionRedacted: !!row.question_redacted,
    answerRedacted: !!row.answer_redacted,
  }
  // The buyer sees who asked (they will see the name on the quote anyway); a provider never does.
  return viewer.role === 'buyer' ? { ...base, askedByName: row.provider?.display_name ?? null } : base
}

/** The thread for a caller: unanswered first, then oldest first; soft-deleted rows excluded. */
export async function listClarifications(
  admin: SupabaseClient,
  rfqId: string,
  viewer: { role: 'buyer' } | { role: 'provider'; providerId: string },
): Promise<ClarificationView[]> {
  const cols = 'id, provider_id, question, question_redacted, answer, answer_redacted, asked_at, answered_at' + (viewer.role === 'buyer' ? ', provider:provider_profiles!inner(display_name)' : '')
  const { data } = await admin.from('rfq_clarifications').select(cols).eq('rfq_id', rfqId).is('deleted_at', null).order('asked_at', { ascending: true })
  const rows = ((data ?? []) as unknown as Row[]).map((r) => toClarificationView(r, viewer))
  return sortClarifications(rows)
}

/** Open (unanswered) questions per RFQ, for list badges. Missing key = 0. */
export async function countOpenQuestions(admin: SupabaseClient, rfqIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (rfqIds.length === 0) return out
  const { data } = await admin.from('rfq_clarifications').select('rfq_id').in('rfq_id', rfqIds).is('answered_at', null).is('deleted_at', null)
  for (const r of (data ?? []) as { rfq_id: string }[]) out.set(r.rfq_id, (out.get(r.rfq_id) ?? 0) + 1)
  return out
}

/** RFQ ids (from the given set) where THIS provider still has an unanswered question — the provider list chip. */
export async function rfqsWithMyOpenQuestion(admin: SupabaseClient, rfqIds: string[], providerId: string): Promise<Set<string>> {
  const out = new Set<string>()
  if (rfqIds.length === 0) return out
  const { data } = await admin.from('rfq_clarifications').select('rfq_id').in('rfq_id', rfqIds).eq('provider_id', providerId).is('answered_at', null).is('deleted_at', null)
  for (const r of (data ?? []) as { rfq_id: string }[]) out.add(r.rfq_id)
  return out
}

/** The cap query: this provider's open questions on this RFQ. */
export async function countOpenQuestionsByProvider(admin: SupabaseClient, rfqId: string, providerId: string): Promise<number> {
  const { count } = await admin.from('rfq_clarifications').select('id', { count: 'exact', head: true }).eq('rfq_id', rfqId).eq('provider_id', providerId).is('answered_at', null).is('deleted_at', null)
  return count ?? 0
}

/** Matched, non-declined providers' user ids on an RFQ — the answer fan-out audience (the asker included). */
export async function matchedProviderUserIds(admin: SupabaseClient, rfqId: string): Promise<string[]> {
  const { data } = await admin.from('rfq_matches').select('provider:provider_profiles!inner(user_id)').eq('rfq_id', rfqId).is('declined_at', null)
  const ids = ((data ?? []) as any[]).map((m) => m.provider?.user_id as string | undefined).filter((x): x is string => !!x)
  return [...new Set(ids)]
}
/* eslint-enable @typescript-eslint/no-explicit-any */
