import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export interface DeliveryDefaults {
  contact_name: string
  contact_phone: string
  address: string
  city: string
  state: string
  pincode: string
  pickup: boolean
  source: 'last_order' | 'profile'
}

/**
 * Delivery defaults, most specific first: the buyer's last goods-order
 * delivery snapshot, else the MSME profile (city/state/pincode) + the
 * account phone. Forms are prefilled; the buyer edits, never retypes.
 * Shared by goods checkout and pool join.
 */
export async function deliveryDefaults(admin: Admin, userId: string): Promise<DeliveryDefaults | null> {
  const [{ data: msme }, { data: user }] = await Promise.all([
    admin.from('msme_profiles').select('id, business_name, city, state, pincode').eq('user_id', userId).maybeSingle(),
    admin.from('users').select('phone, full_name').eq('id', userId).maybeSingle(),
  ])
  if (!msme) return null
  const { data: last } = await admin
    .from('orders')
    .select('delivery_snapshot')
    .eq('msme_id', msme.id)
    .eq('kind', 'goods')
    .not('delivery_snapshot', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const snap = (last?.delivery_snapshot ?? null) as Partial<DeliveryDefaults> | null
  const phone = (user?.phone ?? '').replace(/^\+91/, '')
  return {
    contact_name: snap?.contact_name ?? user?.full_name ?? '',
    contact_phone: snap?.contact_phone ?? phone,
    address: snap?.address ?? '',
    city: snap?.city ?? msme.city ?? '',
    state: snap?.state ?? msme.state ?? 'AP',
    pincode: snap?.pincode ?? msme.pincode ?? '',
    pickup: snap?.pickup ?? false,
    source: snap ? 'last_order' : 'profile',
  }
}
