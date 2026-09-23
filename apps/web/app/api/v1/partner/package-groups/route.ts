import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { packageGroupUpsertSchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { captureServerEvent } from '@/lib/analytics/server'
import { isOnFor } from '@/lib/experiments'
import { loadTierEditor, saveTierGroup } from '@/lib/catalog/package-group-admin'
import { revalidateProviderCatalog } from '@/lib/catalog/revalidate'

/**
 * Experience v3 E4 (FR-4.1) — package tiers. 404 unless flag `packages` is on
 * for the caller. Session only (never a delegated token): a group changes
 * what buyers see on the public page.
 *  GET  — the caller's groups + their packages (priced on the server).
 *  POST — create or update one group of 2–3 of the caller's OWN packages in
 *         one category (validated by packageGroupUpsertSchema).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

async function provider(userId: string) {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  return { admin, providerId: actor.providerId }
}

export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isOnFor('packages', userId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { admin, providerId } = await provider(userId)
  if (!providerId) return NextResponse.json({ error: 'Not a provider' }, { status: 403 })
  try {
    return NextResponse.json(await loadTierEditor(admin, providerId), { headers: NO_STORE })
  } catch {
    return NextResponse.json({ error: 'tier_editor_unavailable' }, { status: 503 })
  }
}

export async function POST(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isOnFor('packages', userId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const delegated = await requireNotDelegated('POST /partner/package-groups')
  if (delegated) return delegated
  const { admin, providerId } = await provider(userId)
  if (!providerId) return NextResponse.json({ error: 'Not a provider' }, { status: 403 })
  const rl = await enforce(limiters.authed, `package-groups:${providerId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const parsed = packageGroupUpsertSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const res = await saveTierGroup(admin, providerId, parsed.data)
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status })
  await revalidateProviderCatalog(admin, providerId)
  captureServerEvent(userId, 'package_group_saved', {
    tiers: parsed.data.tiers.length,
    rows: parsed.data.compareRows.length,
    created: !parsed.data.id,
  })
  return NextResponse.json({ id: res.groupId }, { status: parsed.data.id ? 200 : 201, headers: NO_STORE })
}
