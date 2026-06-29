import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'

/** GET — MSME list/search (q over business name, ?state=). */
export async function GET(request: NextRequest) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const sp = new URL(request.url).searchParams
  const q = sp.get('q')?.trim()
  const state = sp.get('state')

  const admin = await createAdminClient()
  let query = admin
    .from('msme_profiles')
    .select('id, business_name, sector, state, city, membership_tier, gstin_verified, created_at, deleted_at')
    .order('created_at', { ascending: false })
    .limit(200)
  if (q) query = query.ilike('business_name', `%${q}%`)
  if (state) query = query.eq('state', state)
  const { data } = await query
  return NextResponse.json({ msmes: data ?? [] })
}
