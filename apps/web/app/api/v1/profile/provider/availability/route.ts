import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { providerAvailabilitySchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { serverError } from '@/lib/api/errors'
import { revalidateProviderCatalog } from '@/lib/catalog/revalidate'

/**
 * PATCH /api/v1/profile/provider/availability (E3 / N11) — the caller's OWN
 * "next available" date and capacity slots. Display only: matching and
 * fan-out never read these (a separate decision).
 */
export const runtime = 'nodejs'

export async function PATCH(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('profile/provider/availability')
  if (delegated) return delegated
  const parsed = providerAvailabilitySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const admin = await createAdminClient()
  const { data: p } = await admin.from('provider_profiles').select('id').eq('user_id', userId).maybeSingle()
  if (!p) return NextResponse.json({ error: 'No provider profile' }, { status: 404 })
  const { error } = await admin
    .from('provider_profiles')
    .update({ next_available_on: parsed.data.nextAvailableOn, capacity_slots: parsed.data.capacitySlots })
    .eq('id', p.id)
  if (error) return serverError('[provider/availability PATCH]', error)
  await revalidateProviderCatalog(admin, p.id as string)
  return NextResponse.json(parsed.data)
}
