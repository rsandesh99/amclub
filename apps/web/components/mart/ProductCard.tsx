import Image from 'next/image'
import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { formatINRExact } from '@/lib/format'
import { publicAssetUrl } from '@/lib/mart/assets'
import type { ProductSummary } from '@/lib/mart/queries'

/**
 * Catalog card — sheet card, dark body text, ONE gold-adjacent element (the
 * price numeral). Server component: no JS shipped per card. The thumbnail is
 * a fixed 96px box through next/image (sized → zero CLS; AVIF/WebP at exactly
 * 2× the box, ~4 KB each on 4G).
 */
export function ProductCard({ product, priority = false }: { product: ProductSummary; priority?: boolean }) {
  const t = useTranslations('mart')
  const list = product.list
  const img = product.images[0] ? publicAssetUrl(product.images[0]) : null
  return (
    <Link
      href={`/mart/p/${product.id}` as '/services'}
      className="sheet-card flex gap-3 p-3 transition hover:shadow-modal motion-safe:hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald"
    >
      <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-[8px] bg-emerald-ink/5">
        {img ? (
          <Image src={img} alt="" fill sizes="96px" className="object-cover" priority={priority} />
        ) : (
          <div className="jaali-ivory h-full w-full" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="line-clamp-2 text-body font-semibold leading-snug text-emerald-ink">{product.name}</h3>
        <p className="truncate text-xs text-foreground-secondary">
          {product.brand ? `${product.brand} · ` : ''}
          {product.seller.displayName}
          {product.seller.city ? ` · ${product.seller.city}` : ''}
        </p>
        {list && (
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5">
            <span className="font-display text-xl font-bold tabular-nums text-ink">{formatINRExact(list.unit_price_paise)}</span>
            <span className="text-xs text-foreground-secondary">{t('per_unit', { unit: product.unit })} · {t('excl_gst')}</span>
          </div>
        )}
        {list && product.itcEligible && (
          <p className="text-xs text-emerald">
            {t('itc_label')}: <span className="font-semibold tabular-nums">{formatINRExact(list.unit_after_itc_paise)}</span>
          </p>
        )}
        {/* E16 N41 / N43 — active promise badges (breached ones are already removed server-side) and "Not returnable". */}
        {(product.promises.length > 0 || !product.returnable) && (
          <ul className="mt-1 flex flex-wrap gap-1" aria-label={t('promises_label')}>
            {product.promises.map((p) => (
              <li key={p} className="rounded-full bg-emerald/10 px-2 py-0.5 text-[11px] font-medium text-emerald" data-promise={p}>{t(`promise_${p}` as 'promise_ships_48h')}</li>
            ))}
            {!product.returnable && <li className="rounded-full bg-ink/5 px-2 py-0.5 text-[11px] text-foreground-secondary">{t('not_returnable')}</li>}
          </ul>
        )}
        <p className="mt-1 text-[11px] text-foreground-secondary">
          {t('min_order', { qty: product.minOrderQty, unit: product.unit })}
          {product.availability === 'lead_time' && product.leadTimeDays ? ` · ${t('lead_time_note', { days: product.leadTimeDays })}` : ''}
          {' · '}{t('hsn')} {product.hsnCode}
        </p>
      </div>
    </Link>
  )
}
