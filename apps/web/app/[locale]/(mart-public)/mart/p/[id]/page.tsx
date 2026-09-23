import type { Metadata } from 'next'
import Image from 'next/image'
import { notFound } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { formatAttributeValue, pickLocale } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { martPageGate } from '@/lib/mart/gate'
import { getPublicProduct } from '@/lib/mart/queries'
import { listMartCategories } from '@/lib/mart/config'
import { publicCategoryAttributes } from '@/lib/mart/attributes'
import { publicAssetUrl } from '@/lib/mart/assets'
import { formatINRExact } from '@/lib/format'
import { getSiteUrl } from '@/lib/site-url'
import { AddToCart } from '@/components/mart/AddToCart'
import { SheetCard } from '@/components/mart/primitives'
import { MART_ENABLED } from '@/lib/flags'

/**
 * Product page — ISR (5 min, purged on edit/approve/suspend). One parallel
 * round trip; the hero image is sized + priority so it is the LCP element
 * and never shifts layout; the tier table is server-computed money.
 */
export const revalidate = 300

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  if (!MART_ENABLED) return {}
  const { id } = await params
  const p = await getPublicProduct(id)
  if (!p) return {}
  const img = p.images[0] ? publicAssetUrl(p.images[0]) : undefined
  return {
    title: p.name,
    description: p.description ?? undefined,
    alternates: { canonical: `/mart/p/${p.id}` },
    openGraph: { title: p.name, description: p.description ?? undefined, type: 'website', ...(img ? { images: [img] } : {}) },
  }
}

export default async function MartProductPage({ params }: { params: Promise<{ id: string }> }) {
  martPageGate()
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const [product, categories, t, locale, tr] = await Promise.all([getPublicProduct(id), listMartCategories(), getTranslations('mart'), getLocale(), getTranslations('rfq')])
  if (!product) notFound()
  const cat = categories.find((c) => c.slug === product.categorySlug)
  // E16 N40 — the typed attributes, in the category's order, labelled from its definitions.
  const attrDefs = Object.keys(product.attributes).length ? await publicCategoryAttributes(product.categorySlug) : []
  const attrRows = attrDefs.filter((d) => product.attributes[d.key] !== undefined)
  const images = product.images.map(publicAssetUrl)
  const list = product.list
  const url = `${getSiteUrl()}/mart/p/${product.id}`
  const share = list
    ? `https://wa.me/?text=${encodeURIComponent(t('share_text', { name: product.name, price: formatINRExact(list.unit_price_paise), unit: product.unit, url }))}`
    : null
  const seller = product.seller

  return (
    <div className="mart-enter mx-auto max-w-3xl px-4 pb-28 pt-6">
      <nav className="flex flex-wrap items-center gap-1 text-meta text-foreground-secondary" aria-label="Breadcrumb">
        <Link href={'/mart' as '/services'} className="inline-flex min-h-11 items-center hover:underline">{t('title')}</Link>
        {cat && (
          <>
            <span aria-hidden="true">/</span>
            <Link href={`/mart/c/${cat.slug}` as '/services'} className="inline-flex min-h-11 items-center hover:underline">{pickLocale(cat.name_i18n, locale)}</Link>
          </>
        )}
      </nav>

      <SheetCard className="mt-1 p-0">
        {images.length > 0 ? (
          <div className="flex gap-2 overflow-x-auto p-3">
            {images.map((src, i) => (
              <div key={src} className="relative h-56 w-56 shrink-0 overflow-hidden rounded-[8px] bg-emerald-ink/5">
                <Image src={src} alt={i === 0 ? product.name : ''} fill sizes="224px" className="object-cover" priority={i === 0} />
              </div>
            ))}
          </div>
        ) : (
          <div className="jaali-ivory h-40 rounded-t-[10px]" aria-hidden="true" />
        )}
        <div className="p-4">
          <h1 className="font-display text-2xl font-bold tracking-tight text-emerald-ink">{product.name}</h1>
          {product.brand && <p className="mt-0.5 text-meta font-medium text-emerald-ink">{product.brand}</p>}

          {/* Seller trust line — real numbers only (RULES.md 15): rating shows only when reviews exist. */}
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-foreground-secondary">
            <span>
              {t('sold_by')}{' '}
              <Link href={`/p/${seller.slug}` as '/services'} className="inline-flex min-h-11 items-center font-medium text-emerald underline underline-offset-2">
                {seller.displayName}
              </Link>
            </span>
            <span className="inline-flex items-center gap-1 rounded-chip bg-emerald/10 px-2 py-0.5 text-xs font-semibold text-emerald">✓ {t('trust_verified')}</span>
            {seller.avgRating !== null && seller.reviewCount > 0 && <span>{t('trust_rating', { rating: seller.avgRating.toFixed(1), count: seller.reviewCount })}</span>}
            {seller.completedOrders > 0 ? <span>{t('trust_orders', { count: seller.completedOrders })}</span> : <span>{t('trust_new')}</span>}
            <span>{seller.city ? `${seller.city}, ${seller.state}` : seller.state}</span>
          </div>

          {product.description && <p className="mt-3 whitespace-pre-line text-body text-emerald-ink">{product.description}</p>}

          <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-meta text-foreground-secondary">
            <div><dt className="inline">{t('hsn')}: </dt><dd className="inline font-medium text-emerald-ink">{product.hsnCode}</dd></div>
            <div><dd className="inline font-medium text-emerald-ink">{t('gst_rate', { rate: product.gstRateBps / 100 })}</dd></div>
            <div><dd className="inline">{t('min_order', { qty: product.minOrderQty, unit: product.unit })}</dd></div>
            <div>
              <dt className="inline">{t('availability')}: </dt>
              <dd className="inline font-medium text-emerald-ink">
                {product.availability === 'lead_time' ? `${t('lead_time')}${product.leadTimeDays ? ` · ${t('lead_time_note', { days: product.leadTimeDays })}` : ''}` : t('in_stock')}
              </dd>
            </div>
            <div><dd className="inline">{t('field_country')}: {product.countryOfOrigin}</dd></div>
          </dl>
          {share && (
            <a
              href={share}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-button border border-brass/60 px-3 text-meta font-medium text-emerald-ink hover:bg-emerald/10"
            >
              <span aria-hidden="true">🟢</span> {t('share_whatsapp')}
            </a>
          )}
        </div>
      </SheetCard>

      {/* Price-tier dimension table — Zerodha restraint: numbers first, tabular. */}
      <SheetCard className="mt-4">
        <h2 className="text-meta font-semibold text-emerald-ink">{t('tiers_title')}</h2>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-meta">
            <thead>
              <tr className="border-b border-brass/40 text-left text-xs text-foreground-secondary">
                <th className="py-2 pr-3 font-medium">{t('tier_qty')}</th>
                <th className="py-2 pr-3 font-medium">{t('tier_unit_price', { unit: product.unit })}</th>
                <th className="py-2 pr-3 font-medium">{t('tier_incl_gst')}</th>
                <th className="py-2 font-medium text-emerald">{t('tier_after_itc')}</th>
              </tr>
            </thead>
            <tbody>
              {product.tiers.map((tier) => (
                <tr key={tier.min_qty} className="border-b border-brass/20 text-emerald-ink">
                  <td className="py-2 pr-3 tabular-nums">{tier.min_qty}+</td>
                  <td className="py-2 pr-3 font-display text-lg font-bold tabular-nums text-ink">{formatINRExact(tier.unit_price_paise)}</td>
                  <td className="py-2 pr-3 tabular-nums">{formatINRExact(tier.unit_incl_gst_paise)}</td>
                  <td className="py-2 font-semibold tabular-nums text-emerald">{formatINRExact(tier.unit_after_itc_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-foreground-secondary">{t('itc_hint')}</p>
        {cat && <p className="mt-1 text-xs text-foreground-secondary">{t('return_window_note', { hours: cat.return_window_hours })} {t(`return_freight_${cat.return_freight_payer ?? 'seller'}`)}</p>}
        {/* AMC Mart M2 — bulk / custom-spec → goods RFQ prefilled from this listing. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-brass/30 pt-3">
          <Link href={`/app/mart/rfq/new?product_id=${product.id}` as '/app'} className="inline-flex min-h-11 items-center rounded-button border border-brass/60 px-3 text-meta font-semibold text-emerald-ink hover:bg-emerald/10">
            {tr('goods_ask_cta')}
          </Link>
          <span className="text-xs text-foreground-secondary">{tr('goods_ask_hint')}</span>
        </div>
      </SheetCard>

      {(attrRows.length > 0 || product.specs.length > 0) && (
        <SheetCard className="mt-4">
          <h2 className="text-meta font-semibold text-emerald-ink">{t('specs')}</h2>
          <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-y-1 text-meta">
            {attrRows.map((d) => (
              <div key={`a-${d.key}`} className="contents" data-attribute={d.key}>
                <dt className="border-b border-brass/20 py-1.5 text-foreground-secondary">{pickLocale(d.label_i18n, locale)}</dt>
                <dd className="border-b border-brass/20 py-1.5 text-emerald-ink">{formatAttributeValue(d, product.attributes[d.key], { yes: t('attr_yes'), no: t('attr_no') })}</dd>
              </div>
            ))}
            {product.specs.map((s) => (
              <div key={s.k} className="contents">
                <dt className="border-b border-brass/20 py-1.5 text-foreground-secondary">{s.k}</dt>
                <dd className="border-b border-brass/20 py-1.5 text-emerald-ink">{s.v}</dd>
              </div>
            ))}
          </dl>
        </SheetCard>
      )}

      <AddToCart
        productId={product.id}
        name={product.name}
        unit={product.unit}
        sellerId={seller.id}
        sellerName={seller.displayName}
        minOrderQty={product.minOrderQty}
        imageUrl={images[0] ?? null}
      />
    </div>
  )
}
