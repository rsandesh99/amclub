import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { deliveryDefaults } from '@/lib/mart/delivery-defaults'

export const dynamic = 'force-dynamic'

/** The caller's prefilled delivery details (last goods order, else profile). */
export async function GET() {
  const gate = martApiGate()
  if (gate) return gate
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const defaults = await deliveryDefaults(await createAdminClient(), userId)
  return NextResponse.json({ defaults }, { headers: { 'Cache-Control': 'private, no-store' } })
}
