import { getTranslations } from 'next-intl/server'
import { notFound, redirect } from 'next/navigation'
import { martPageGate } from '@/lib/mart/gate'
import { INDIAN_STATES } from '@amclub/shared'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { GoodsCheckoutClient } from './GoodsCheckoutClient'
import { deliveryDefaults } from '@/lib/mart/delivery-defaults'
import { getPublicProduct } from '@/lib/mart/queries'
import { publicAssetUrl } from '@/lib/mart/assets'


export default async function MartCheckoutPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  martPageGate()
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/mart/checkout')
  const [sp, t, defaults] = await Promise.all([searchParams, getTranslations('mart'), deliveryDefaults(await createAdminClient(), user.id)])
  // E16 N42 — `?sample=<product id>`: one unit at the listing's sample price, outside the cart.
  const sampleId = sp['sample'] && /^[0-9a-f-]{36}$/i.test(sp['sample']) ? sp['sample'] : null
  const product = sampleId ? await getPublicProduct(sampleId) : null
  if (sampleId && !product?.sample) notFound()
  const sample = product
    ? { productId: product.id, name: product.name, unit: product.unit, sellerId: product.seller.id, sellerName: product.seller.displayName, imageUrl: product.images[0] ? publicAssetUrl(product.images[0]) : null }
    : undefined
  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="font-display text-2xl font-bold text-emerald-ink">{sample ? t('sample_checkout_title') : t('checkout_title')}</h1>
      <p className="mb-6 mt-1 text-sm text-foreground-secondary">{sample ? t('sample_checkout_subtitle') : t('checkout_subtitle')}</p>
      <GoodsCheckoutClient sellerId={sp['seller'] ?? null} states={INDIAN_STATES.map((s) => ({ value: s.value, label: s.label }))} defaults={defaults} sample={sample} />
    </div>
  )
}
