import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { bundlesOn, plansForBuyer } from '@/lib/bundles'

export const dynamic = 'force-dynamic'

/** E12c / ADR 021 — the buyer's plans with their milestone orders (404 while bundles are off). */
export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = await createAdminClient()
  if (!(await bundlesOn(admin))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { data: msme } = await admin.from('msme_profiles').select('id').eq('user_id', userId).maybeSingle()
  if (!msme) return NextResponse.json({ plans: [] })
  return NextResponse.json({ plans: await plansForBuyer(admin, msme.id as string) }, { headers: { 'Cache-Control': 'private, no-store' } })
}
