import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { pickLocale } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { martPageGate } from '@/lib/mart/gate'
import { getPublicProduct } from '@/lib/mart/queries'
import { listMartCategories } from '@/lib/mart/config'
import { publicAssetUrl } from '@/lib/mart/assets'
import { formatINR } from '@/lib/format'
import { AddToCart } from '@/components/mart/AddToCart'
import { SheetCard } from '@/components/mart/primitives'
import { MART_ENABLED } from '@/lib/flags'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  if (!MART_ENABLED) return {}
  const { id } = await params
  const p = await getPublicProduct(id)
  return p ? { title: p.name, description: p.description ?? undefined } : {}
}

/** Product page (FRONTEND.md §7): sheet card + price-tier dimension table + ITC line + sticky Add. */
export default async function MartProductPage({ params }: { params: Promise<{ id: string }> }) {
  martPageGate()
  const { id } = await params
  const product = await getPublicProduct(id)
  if (!product) notFound()
  const t = await getTranslations('mart')
  const locale = await getLocale()
  const categories = await listMartCategories()
  const cat = categories.find((c) => c.slug === product.categorySlug)
  const images = product.images.map(publicAssetUrl)

  return (
    <div className="mart-enter mx-auto max-w-3xl px-4 py-6">
      <nav className="text-xs text-foreground-secondary">
        <Link href={'/mart' as '/services'} className="hover:underline">{t('title')}</Link>
        {cat && (
          <>
            {' / '}
            <Link href={`/mart?category=${cat.slug}` as '/services'} className="hover:underline">{pickLocale(cat.name_i18n, locale)}</Link>
          </>
        )}
      </nav>

      <SheetCard className="mt-3 p-0">
        {images.length > 0 ? (
          <div className="flex gap-2 overflow-x-auto p-3">
            {images.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={src} src={src} alt={i === 0 ? product.name : ''} className="h-56 w-56 shrink-0 rounded-[8px] object-cover" />
            ))}
          </div>
        ) : (
          <div className="jaali-ivory h-40 rounded-t-[10px]" aria-hidden="true" />
        )}
        <div className="p-4">
          <h1 className="font-display text-2xl font-bold tracking-tight text-emerald-ink">{product.name}</h1>
          <p className="mt-1 text-sm text-foreground-secondary">
            {t('sold_by')}{' '}
            <Link href={`/p/${product.seller.slug}` as '/services'} className="font-medium text-emerald underline underline-offset-2">
              {product.seller.displayName}
            </Link>
            {product.seller.city ? ` · ${product.seller.city}, ${product.seller.state}` : ` · ${product.seller.state}`}
          </p>
          {product.description && <p className="mt-3 whitespace-pre-line text-md text-emerald-ink">{product.description}</p>}
          <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground-secondary">
            <div><dt className="inline">{t('hsn')}: </dt><dd className="inline font-medium text-emerald-ink">{product.hsnCode}</dd></div>
            <div><dd className="inline font-medium text-emerald-ink">{t('gst_rate', { rate: product.gstRateBps / 100 })}</dd></div>
            <div><dd className="inline">{t('min_order', { qty: product.minOrderQty, unit: product.unit })}</dd></div>
            <div><dd className="inline">{t('field_country')}: {product.countryOfOrigin}</dd></div>
          </dl>
        </div>
      </SheetCard>

      {/* Price-tier dimension table — Zerodha restraint: numbers first, tabular. */}
      <SheetCard className="mt-4">
        <h2 className="text-sm font-semibold text-emerald-ink">{t('tiers_title')}</h2>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-brass/40 text-left text-xs text-foreground-secondary">
                <th className="py-2 pr-3 font-medium">{t('tier_qty')}</th>
                <th className="py-2 pr-3 font-medium">{t('tier_unit_price', { unit: product.unit })}</th>
                <th className="py-2 pr-3 font-medium">{t('tier_incl_gst')}</th>
                <th className="py-2 font-medium text-emerald">{t('tier_after_itc')}</th>
              </tr>
            </thead>
            <tbody>
              {product.tiers.map((tier, i) => (
                <tr key={tier.min_qty} className={`border-b border-brass/20 ${i === 0 ? '' : 'text-emerald-ink'}`}>
                  <td className="py-2 pr-3 tabular-nums">{tier.min_qty}+</td>
                  <td className="py-2 pr-3 font-display text-lg font-bold tabular-nums text-ink">{formatINR(tier.unit_price_paise)}</td>
                  <td className="py-2 pr-3 tabular-nums">{formatINR(tier.unit_incl_gst_paise)}</td>
                  <td className="py-2 font-semibold tabular-nums text-emerald">{formatINR(tier.unit_after_itc_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-foreground-secondary">{t('itc_hint')}</p>
        {cat && <p className="mt-1 text-xs text-foreground-secondary">{t('return_window_note', { hours: cat.return_window_hours })}</p>}
      </SheetCard>

      <AddToCart
        productId={product.id}
        name={product.name}
        unit={product.unit}
        sellerId={product.seller.id}
        sellerName={product.seller.displayName}
        minOrderQty={product.minOrderQty}
        imageUrl={images[0] ?? null}
      />
    </div>
  )
}
