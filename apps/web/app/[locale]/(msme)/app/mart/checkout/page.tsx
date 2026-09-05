import { getTranslations } from 'next-intl/server'
import { martPageGate } from '@/lib/mart/gate'
import { INDIAN_STATES } from '@amclub/shared'
import { GoodsCheckoutClient } from './GoodsCheckoutClient'

export default async function MartCheckoutPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  martPageGate()
  const sp = await searchParams
  const t = await getTranslations('mart')
  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="font-display text-2xl font-bold text-emerald-ink">{t('checkout_title')}</h1>
      <p className="mb-6 mt-1 text-sm text-foreground-secondary">{t('checkout_subtitle')}</p>
      <GoodsCheckoutClient sellerId={sp['seller'] ?? null} states={INDIAN_STATES.map((s) => ({ value: s.value, label: s.label }))} />
    </div>
  )
}
