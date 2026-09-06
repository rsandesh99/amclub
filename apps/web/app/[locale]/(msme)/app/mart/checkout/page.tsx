import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { martPageGate } from '@/lib/mart/gate'
import { INDIAN_STATES } from '@amclub/shared'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { GoodsCheckoutClient } from './GoodsCheckoutClient'
import { deliveryDefaults } from '@/lib/mart/delivery-defaults'


export default async function MartCheckoutPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  martPageGate()
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/mart/checkout')
  const [sp, t, defaults] = await Promise.all([searchParams, getTranslations('mart'), deliveryDefaults(await createAdminClient(), user.id)])
  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="font-display text-2xl font-bold text-emerald-ink">{t('checkout_title')}</h1>
      <p className="mb-6 mt-1 text-sm text-foreground-secondary">{t('checkout_subtitle')}</p>
      <GoodsCheckoutClient sellerId={sp['seller'] ?? null} states={INDIAN_STATES.map((s) => ({ value: s.value, label: s.label }))} defaults={defaults} />
    </div>
  )
}
