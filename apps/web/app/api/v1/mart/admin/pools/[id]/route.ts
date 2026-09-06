import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { poolOpenSchema, POOL_ADMIN_ACTIONS } from '@amclub/shared'
import { martApiGate } from '@/lib/mart/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import {
  getPool, listMembers, poolProgressFor, approveAndOpenPool, cancelPool, closePool, settlePool, fulfilPool, buyerDiscipline, addPoolEvent,
} from '@/lib/mart/pools'
import { recordAiDecision } from '@/lib/mart/events'

export const dynamic = 'force-dynamic'

const actionSchema = z.object({
  action: z.enum(POOL_ADMIN_ACTIONS),
  edits: poolOpenSchema.optional(),
  card_i18n: z.record(z.string(), z.string().max(200)).nullable().optional(),
  reason: z.string().trim().max(300).optional(),
})

/** Pool dossier: row + members (with discipline) + events. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = martApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const { id } = await params
  const admin = await createAdminClient()
  const pool = await getPool(admin, id)
  if (!pool) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const members = await listMembers(admin, id)
  const enriched = []
  for (const m of members) {
    const { data: msme } = await admin.from('msme_profiles').select('business_name, city').eq('id', m.msme_id).maybeSingle()
    enriched.push({ ...m, business_name: msme?.business_name ?? null, city: msme?.city ?? null, discipline: await buyerDiscipline(admin, m.msme_id) })
  }
  const { data: events } = await admin.from('pool_events').select('id, event_type, member_id, actor_id, payload, created_at').eq('pool_id', id).order('created_at', { ascending: true })
  return NextResponse.json({ pool: { ...pool, progress: poolProgressFor(pool) }, members: enriched, events: events ?? [] }, { headers: { 'Cache-Control': 'private, no-store' } })
}

/**
 * approve  draft → open (with the founder's edits; ai_decisions 'pool_draft' corrections + 'pool_card')
 * cancel   draft | open | closed_met → cancelled (members released)
 * close    open → closed_met | closed_unmet NOW (forced, before closes_at)
 * award    closed_met → settle now (captures paid members, defaults lapsed ones; → ordered when done)
 * fulfil   ordered → fulfilled
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = martApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const rl = await enforce(limiters.adminMutation, `admin:${auth.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const { id } = await params
  const parsed = actionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const { action, edits, card_i18n, reason } = parsed.data
  const admin = await createAdminClient()
  const before = await getPool(admin, id)
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (action === 'approve') {
    const r = await approveAndOpenPool(admin, id, edits ?? {}, auth.userId, card_i18n)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    // The founder's corrections vs the agent's proposal — the training signal.
    const proposed = { title: before.title, target_qty: before.target_qty, min_qty: before.min_qty, unit_price_paise: before.unit_price_paise, closes_at: before.closes_at, card_i18n: before.cardI18n }
    const final = { title: r.pool.title, target_qty: r.pool.target_qty, min_qty: r.pool.min_qty, unit_price_paise: r.pool.unit_price_paise, closes_at: r.pool.closes_at, card_i18n: r.pool.cardI18n }
    await recordAiDecision(admin, auth.userId, { feature: 'pool_draft', input_refs: { pool_id: id, product_id: before.product_id, stage: 'approve' }, proposed, final })
    if (card_i18n !== undefined) {
      await recordAiDecision(admin, auth.userId, { feature: 'pool_card', input_refs: { pool_id: id }, proposed: before.cardI18n ?? {}, final: card_i18n ?? {} })
      await addPoolEvent(admin, id, 'card_confirmed', { actorId: auth.userId })
    }
    return NextResponse.json({ pool: { ...r.pool, progress: poolProgressFor(r.pool) } })
  }
  if (action === 'cancel') {
    const r = await cancelPool(admin, id, auth.userId, reason ?? 'admin')
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ pool: { ...r.pool, progress: poolProgressFor(r.pool) } })
  }
  if (action === 'close') {
    const r = await closePool(admin, id, auth.userId, true)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ pool: { ...r.pool, progress: poolProgressFor(r.pool) } })
  }
  if (action === 'award') {
    const s = await settlePool(admin, id)
    const pool = await getPool(admin, id)
    return NextResponse.json({ pool: pool ? { ...pool, progress: poolProgressFor(pool) } : null, settled: s })
  }
  const r = await fulfilPool(admin, id, auth.userId)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ pool: { ...r.pool, progress: poolProgressFor(r.pool) } })
}
