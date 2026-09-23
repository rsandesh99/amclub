import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { captureServerEvent } from '@/lib/analytics/server'
import { isOnFor } from '@/lib/experiments'
import { deleteTierGroup } from '@/lib/catalog/package-group-admin'
import { revalidateProviderCatalog } from '@/lib/catalog/revalidate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Experience v3 E4 — ungroup: the packages stay live as single packages. */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isOnFor('packages', userId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const delegated = await requireNotDelegated('DELETE /partner/package-groups/[id]')
  if (delegated) return delegated
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return NextResponse.json({ error: 'Not a provider' }, { status: 403 })
  if (!(await deleteTierGroup(admin, actor.providerId, id))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await revalidateProviderCatalog(admin, actor.providerId)
  captureServerEvent(userId, 'package_group_deleted', {})
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } })
}
