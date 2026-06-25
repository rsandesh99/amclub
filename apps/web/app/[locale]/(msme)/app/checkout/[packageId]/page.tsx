import { redirect, notFound } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { computeOrderAmounts } from '@amclub/shared'
import { pickI18n } from '@/lib/format'
import { CheckoutClient } from './CheckoutClient'

export default async function CheckoutPage({ params }: { params: Promise<{ packageId: string }> }) {
  const { packageId } = await params
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=/app/checkout/${packageId}`)

  const t = await getTranslations('checkout')
  const locale = await getLocale()
  const supabase = await createClient()

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const { data: pkg } = await supabase
    .from('packages')
    .select('id, title_i18n, price_paise, discount_bps, member_extra_discount_bps, delivery_days, provider:provider_profiles!inner(display_name, status), category:categories(commission_bps)')
    .eq('id', packageId)
    .eq('status', 'active')
    .maybeSingle()
  const p = pkg as any
  if (!p || p.provider?.status !== 'active') notFound()

  const commissionBps = p.category?.commission_bps ?? 1000
  const amounts = computeOrderAmounts({ pricePaise: Number(p.price_paise), discountBps: p.discount_bps, commissionBps })
  const title = pickI18n(p.title_i18n, locale)
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="mb-1 font-display text-2xl font-bold">{t('title')}</h1>
      <p className="mb-6 text-sm text-foreground-secondary">{t('subtitle')}</p>
      <CheckoutClient
        packageId={p.id}
        title={title}
        providerName={p.provider.display_name}
        deliveryDays={p.delivery_days}
        amounts={amounts}
      />
    </div>
  )
}
