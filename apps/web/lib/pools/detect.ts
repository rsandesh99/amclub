import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { clusterPoolCandidates, poolCandidateFits, poolKey, type PoolCandidate } from '@amclub/shared'
import { createNotification } from '@/lib/notifications/create'
import { notifyText } from '@/lib/i18n/notify'
import { captureServerEvent } from '@/lib/analytics/server'
import { addPoolEvent, chunks, cohortUserIds, poolSettings, type PoolSettings } from './core'

/**
 * S3.4 (ADR 024) — the agent's proposal: code, no model. Groups open, released services requests from cohort buyers
 * by (category, service, buyer state) with the shared rule, tops up live groups with the same key, and invites each
 * member's buyer. A request is invited at most once in its life (a dismissal is never re-asked).
 */

interface RfqCandidateRow {
  id: string
  msme_id: string
  category_id: string
  details: Record<string, unknown> | null
  must_haves: { credentials?: unknown[]; languages?: unknown[]; onSite?: boolean; inStateOnly?: boolean } | null
  created_at: string
  expires_at: string
}

function hasMustHaves(m: RfqCandidateRow['must_haves']): boolean {
  if (!m) return false
  return (Array.isArray(m.credentials) && m.credentials.length > 0) || (Array.isArray(m.languages) && m.languages.length > 0) || !!m.onSite || !!m.inStateOnly
}

async function loadCandidates(admin: SupabaseClient, now: Date): Promise<PoolCandidate[]> {
  const cohort = await cohortUserIds(admin)
  if (cohort.length === 0) return []
  const stateOf = new Map<string, string | null>()
  for (const part of chunks(cohort)) {
    const { data } = await admin.from('msme_profiles').select('id, state').in('user_id', part).is('deleted_at', null)
    for (const m of (data ?? []) as Array<{ id: string; state: string | null }>) stateOf.set(m.id, m.state)
  }
  if (stateOf.size === 0) return []

  const rows: RfqCandidateRow[] = []
  for (const part of chunks([...stateOf.keys()])) {
    const { data } = await admin
      .from('rfqs')
      // Services only: goods RFQs have no category_id (never name a staged Mart column here).
      .select('id, msme_id, category_id, details, must_haves, created_at, expires_at')
      .in('msme_id', part)
      .in('status', ['open', 'quoted'])
      .not('category_id', 'is', null)
      .not('fanout_at', 'is', null)
      .is('deleted_at', null)
      .gt('expires_at', now.toISOString())
      .limit(1000)
    rows.push(...((data ?? []) as RfqCandidateRow[]))
  }
  if (rows.length === 0) return []

  // One invitation per request, ever: any membership row (live or not) takes it out.
  const seen = new Set<string>()
  for (const part of chunks(rows.map((r) => r.id))) {
    const { data } = await admin.from('service_pool_members').select('rfq_id').in('rfq_id', part)
    for (const m of (data ?? []) as Array<{ rfq_id: string }>) seen.add(m.rfq_id)
  }

  return rows
    .filter((r) => !seen.has(r.id))
    .map((r) => ({
      rfqId: r.id,
      msmeId: r.msme_id,
      categoryId: r.category_id,
      serviceSlug: typeof r.details?.['service_slug'] === 'string' && (r.details['service_slug'] as string).length > 0 ? (r.details['service_slug'] as string) : null,
      state: stateOf.get(r.msme_id) ?? null,
      hasMustHaves: hasMustHaves(r.must_haves),
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }))
}

/** Insert invited memberships (one by one: the live-request unique index settles any race). Returns who was added. */
async function invite(admin: SupabaseClient, poolId: string, members: readonly PoolCandidate[]): Promise<PoolCandidate[]> {
  const added: PoolCandidate[] = []
  for (const c of members) {
    const { error } = await admin.from('service_pool_members').insert({ pool_id: poolId, rfq_id: c.rfqId, msme_id: c.msmeId, status: 'invited' })
    if (!error) added.push(c)
    else if ((error as { code?: string }).code !== '23505') console.error('[pools] invite failed', { poolId, rfqId: c.rfqId, message: error.message })
  }
  return added
}

async function notifyInvited(admin: SupabaseClient, poolId: string, added: readonly PoolCandidate[], memberCount: number): Promise<void> {
  if (added.length === 0) return
  const { data } = await admin.from('msme_profiles').select('id, user_id').in('id', added.map((a) => a.msmeId))
  const userOf = new Map(((data ?? []) as Array<{ id: string; user_id: string }>).map((m) => [m.id, m.user_id]))
  for (const c of added) {
    const userId = userOf.get(c.msmeId)
    if (!userId) continue
    await createNotification(admin, {
      userId,
      kind: 'pool_invite',
      titleI18n: notifyText('pool_invite.title'),
      bodyI18n: notifyText('pool_invite.body', { n: Math.max(memberCount - 1, 1) }),
      link: `/app/rfq/${c.rfqId}`,
    })
    captureServerEvent(userId, 'pool_invited', { pool_id: poolId })
  }
}

export interface ProposeResult {
  enabled: true
  proposed: number
  invited: number
}

export async function proposePools(admin: SupabaseClient, now = new Date(), settings?: PoolSettings): Promise<ProposeResult> {
  const s = settings ?? (await poolSettings(admin))
  let candidates = await loadCandidates(admin, now)
  let proposed = 0
  let invited = 0
  if (candidates.length === 0) return { enabled: true, proposed, invited }

  // 1. Top up live groups (forming / open) with the same key.
  const { data: live } = await admin.from('service_pools').select('id, category_id, service_slug, state, status, closes_at, max_members').in('status', ['forming', 'open'])
  for (const p of (live ?? []) as Array<{ id: string; category_id: string; service_slug: string; state: string; status: 'forming' | 'open'; closes_at: string | null; max_members: number }>) {
    const key = poolKey({ categoryId: p.category_id, serviceSlug: p.service_slug, state: p.state })
    const { data: current } = await admin.from('service_pool_members').select('msme_id, status').eq('pool_id', p.id)
    const cur = (current ?? []) as Array<{ msme_id: string; status: string }>
    const buyersIn = new Set(cur.map((m) => m.msme_id))
    const room = p.max_members - cur.filter((m) => m.status === 'invited' || m.status === 'joined').length
    if (room <= 0) continue
    const newest = new Map<string, PoolCandidate>()
    for (const c of candidates) {
      if (!c.serviceSlug || !c.state || poolKey({ categoryId: c.categoryId, serviceSlug: c.serviceSlug, state: c.state }) !== key) continue
      if (buyersIn.has(c.msmeId) || !poolCandidateFits(c, { status: p.status, closesAt: p.closes_at }, now, s.timing)) continue
      const prev = newest.get(c.msmeId)
      if (!prev || c.createdAt > prev.createdAt) newest.set(c.msmeId, c)
    }
    const fits = [...newest.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, room)
    if (fits.length === 0) continue
    const added = await invite(admin, p.id, fits)
    if (added.length) {
      invited += added.length
      await addPoolEvent(admin, p.id, 'invited', null, { rfq_ids: added.map((a) => a.rfqId) })
      await notifyInvited(admin, p.id, added, cur.length + added.length)
    }
    const taken = new Set(fits.map((f) => f.rfqId))
    candidates = candidates.filter((c) => !taken.has(c.rfqId))
  }

  // 2. New groups from what is left.
  const clusters = clusterPoolCandidates(candidates, { now, minMembers: s.minMembers, maxMembers: s.maxMembers, timing: s.timing })
  const byId = new Map(candidates.map((c) => [c.rfqId, c]))
  for (const cl of clusters) {
    const { data: pool, error } = await admin
      .from('service_pools')
      .insert({
        category_id: cl.categoryId,
        service_slug: cl.serviceSlug,
        state: cl.state,
        status: 'forming',
        min_members: s.minMembers,
        max_members: s.maxMembers,
        form_by: new Date(now.getTime() + s.timing.formHours * 3600_000).toISOString(),
      })
      .select('id')
      .single()
    if (error || !pool) {
      // 23505 = a live group with this key appeared since step 1 (a concurrent run); the next run tops it up.
      if ((error as { code?: string } | null)?.code !== '23505') console.error('[pools] propose failed', { key: cl.key, message: error?.message })
      continue
    }
    const added = await invite(admin, pool.id, cl.rfqIds.map((id) => byId.get(id)!).filter(Boolean))
    proposed++
    invited += added.length
    await addPoolEvent(admin, pool.id, 'proposed', null, { key: cl.key, rfq_ids: added.map((a) => a.rfqId), min_members: s.minMembers })
    await notifyInvited(admin, pool.id, added, added.length)
  }
  return { enabled: true, proposed, invited }
}
