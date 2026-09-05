import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { formatINR } from '@/lib/format'
import { publicAssetUrl } from '@/lib/mart/assets'
import type { ProductSummary } from '@/lib/mart/queries'

/** Catalog card — sheet card, dark body text, ONE gold-adjacent element (the price numeral). */
export function ProductCard({ product }: { product: ProductSummary }) {
  const t = useTranslations('mart')
  const list = product.list
  const img = product.images[0] ? publicAssetUrl(product.images[0]) : null
  return (
    <Link
      href={`/mart/p/${product.id}` as '/services'}
      className="sheet-card flex gap-3 p-3 transition hover:shadow-modal motion-safe:hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald"
    >
      <div className="h-20 w-20 shrink-0 overflow-hidden rounded-[8px] bg-emerald-ink/5">
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="jaali-ivory h-full w-full" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-md font-semibold text-emerald-ink">{product.name}</h3>
        <p className="truncate text-xs text-foreground-secondary">
          {t('sold_by')} {product.seller.displayName}
          {product.seller.city ? ` · ${product.seller.city}` : ''}
        </p>
        {list && (
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-xs text-foreground-secondary">{t('from_price')}</span>
            <span className="font-display text-xl font-bold tabular-nums text-ink">{formatINR(list.unit_price_paise)}</span>
            <span className="text-xs text-foreground-secondary">{t('per_unit', { unit: product.unit })} · {t('excl_gst')}</span>
          </div>
        )}
        {list && (
          <p className="mt-0.5 text-xs text-emerald">
            {t('itc_label')}: <span className="font-semibold tabular-nums">{formatINR(list.unit_after_itc_paise)}</span>
          </p>
        )}
        <p className="mt-1 text-[11px] text-foreground-secondary">
          {t('hsn')} {product.hsnCode} · {t('gst_rate', { rate: product.gstRateBps / 100 })}
        </p>
      </div>
    </Link>
  )
}
