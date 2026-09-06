import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { martPageGate } from '@/lib/mart/gate'
import { INDIAN_STATES } from '@amclub/shared'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { GoodsCheckoutClient, type DeliveryDefaults } from './GoodsCheckoutClient'

/**
 * Delivery defaults, most specific first: the buyer's last goods-order
 * delivery snapshot, else the MSME profile (city/state/pincode) + the
 * account phone. The form is prefilled; the buyer edits, never retypes.
 */
async function deliveryDefaults(userId: string): Promise<DeliveryDefaults | null> {
  const admin = await createAdminClient()
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

export default async function MartCheckoutPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  martPageGate()
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/mart/checkout')
  const [sp, t, defaults] = await Promise.all([searchParams, getTranslations('mart'), deliveryDefaults(user.id)])
  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="font-display text-2xl font-bold text-emerald-ink">{t('checkout_title')}</h1>
      <p className="mb-6 mt-1 text-sm text-foreground-secondary">{t('checkout_subtitle')}</p>
      <GoodsCheckoutClient sellerId={sp['seller'] ?? null} states={INDIAN_STATES.map((s) => ({ value: s.value, label: s.label }))} defaults={defaults} />
    </div>
  )
}
