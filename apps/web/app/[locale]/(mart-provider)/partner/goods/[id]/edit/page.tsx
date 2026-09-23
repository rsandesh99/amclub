import { redirect, notFound } from 'next/navigation'
import { getLocale } from 'next-intl/server'
import { martPageGate } from '@/lib/mart/gate'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { getSellerCtx } from '@/lib/mart/seller'
import { getSellerProduct } from '@/lib/mart/queries'
import { listMartCategories } from '@/lib/mart/config'
import { publicAssetUrl } from '@/lib/mart/assets'
import { CatalogWizard } from '@/components/mart/CatalogWizard'
import { MART_PROMISES, type MartPromise } from '@amclub/shared'

export default async function EditGoodsListingPage({ params }: { params: Promise<{ id: string }> }) {
  martPageGate()
  const { id } = await params
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=/partner/goods/${id}/edit`)
  const admin = await createAdminClient()
  const seller = await getSellerCtx(admin, user.id)
  if (!seller) redirect('/partner/onboarding')
  const [product, categories, locale] = await Promise.all([getSellerProduct(admin, seller.id, id), listMartCategories(), getLocale()])
  if (!product) notFound()
  return (
    <CatalogWizard
      mode="edit"
      productId={product.id}
      locale={locale}
      categories={categories.map((c) => ({ slug: c.slug, nameI18n: c.name_i18n, bisBlocked: c.bis_blocked }))}
      initial={{
        name: product.name,
        description: product.description ?? '',
        categorySlug: product.categorySlug,
        hsnCode: product.hsnCode,
        gstRateBps: String(product.gstRateBps),
        unit: product.unit,
        minOrderQty: String(product.minOrderQty),
        countryOfOrigin: product.countryOfOrigin,
        brand: product.brand ?? '',
        specs: product.specs,
        availability: product.availability,
        leadTimeDays: product.leadTimeDays != null ? String(product.leadTimeDays) : '',
        images: product.images.map((k) => ({ key: k, url: publicAssetUrl(k) })),
        tiers: product.tiers.map((t) => ({ minQty: String(t.min_qty), rupees: (t.unit_price_paise / 100).toString() })),
        attributes: Object.fromEntries(Object.entries(product.attributes).map(([k, v]) => [k, String(v)])),
        promises: product.promises.filter((p): p is MartPromise => (MART_PROMISES as readonly string[]).includes(p)),
      }}
    />
  )
}
