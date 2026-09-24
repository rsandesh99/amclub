import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { reorderLibrary } from '@/lib/mart/reorder'

/** E16 N44 — the buyer's reorder library (the web page and mobile read the same shape). */
export async function GET() {
  const gate = martApiGate()
  if (gate) return gate
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = await createAdminClient()
  const { data: msme } = await admin.from('msme_profiles').select('id').eq('user_id', userId).is('deleted_at', null).maybeSingle()
  const items = msme ? await reorderLibrary(admin, msme.id, userId) : []
  return NextResponse.json({ items }, { headers: { 'Cache-Control': 'private, no-store' } })
}
