import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export interface SellerCtx {
  id: string
  userId: string
  status: string
  sellsGoods: boolean
  displayName: string
}

/** The caller's own provider profile (sellers ARE providers). Null when none. */
export async function getSellerCtx(admin: Admin, userId: string): Promise<SellerCtx | null> {
  const { data } = await admin
    .from('provider_profiles')
    .select('id, user_id, status, sells_goods, display_name')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle()
  if (!data) return null
  return { id: data.id, userId: data.user_id, status: data.status, sellsGoods: !!data.sells_goods, displayName: data.display_name }
}
