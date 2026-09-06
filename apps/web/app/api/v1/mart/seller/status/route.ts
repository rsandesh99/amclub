import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { getSellerCtx } from '@/lib/mart/seller'
import { getGoodsActivation } from '@/lib/mart/activation'

/** The caller's goods-selling activation state (drives the seller catalog banner). */
export async function GET() {
  const gate = martApiGate()
  if (gate) return gate
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = await createAdminClient()
  const seller = await getSellerCtx(admin, userId)
  if (!seller) return NextResponse.json({ error: 'No provider profile' }, { status: 404 })
  const activation = await getGoodsActivation(admin, seller.id)
  return NextResponse.json({ activation }, { headers: { 'Cache-Control': 'private, no-store' } })
}
