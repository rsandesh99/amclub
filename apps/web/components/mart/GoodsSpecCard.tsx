import { useTranslations } from 'next-intl'
import { formatINRExact } from '@/lib/format'
import { SheetCard } from '@/components/mart/primitives'

/** goods_spec as stored on rfqs (goodsRfqSpecSchema output). */
export interface GoodsSpecView {
  item: string
  qty: number
  unit: string
  spec?: { k: string; v: string }[]
  brand_preference?: string
  target_unit_price_paise?: number
  delivery?: { contact_name: string; contact_phone: string; address: string; city: string; state: string; pincode: string; pickup: boolean }
  product_id?: string
}

/**
 * AMC Mart M2 — the requested spec on a goods RFQ, read the same way by the
 * buyer and every matched seller. Money is server-stored paise, rendered only.
 * `showDelivery` is true for the buyer (own address) and for a seller (they
 * price freight against it) — phone is never shown to sellers pre-order.
 */
export function GoodsSpecCard({ spec, categoryName, showPhone = false }: { spec: GoodsSpecView; categoryName: string | null; showPhone?: boolean }) {
  const t = useTranslations('rfq')
  const rows = spec.spec ?? []
  const d = spec.delivery
  return (
    <SheetCard className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-meta font-semibold text-emerald-ink">{t('goods_spec_title')}</h2>
        {categoryName && <span className="rounded-chip bg-emerald/10 px-2 py-0.5 text-xs font-semibold text-emerald">{categoryName}</span>}
      </div>
      <p className="font-display text-lg font-bold text-emerald-ink">{spec.item}</p>
      <p className="text-body text-emerald-ink">
        <span className="font-semibold tabular-nums">{t('goods_qty_line', { qty: spec.qty, unit: spec.unit })}</span>
        {spec.target_unit_price_paise ? <span className="text-foreground-secondary"> · {t('goods_target_line', { price: formatINRExact(spec.target_unit_price_paise), unit: spec.unit })}</span> : null}
        {spec.brand_preference ? <span className="text-foreground-secondary"> · {t('goods_brand_line', { brand: spec.brand_preference })}</span> : null}
      </p>
      {rows.length > 0 ? (
        <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-y-1 text-meta">
          {rows.map((r, i) => (
            <div key={`${r.k}-${i}`} className="contents">
              <dt className="border-b border-brass/20 py-1.5 text-foreground-secondary">{r.k}</dt>
              <dd className="border-b border-brass/20 py-1.5 text-emerald-ink">{r.v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-foreground-secondary">{t('goods_no_spec')}</p>
      )}
      {d && (
        <div className="border-t border-brass/30 pt-3 text-meta">
          <p className="text-xs text-foreground-secondary">{t('goods_deliver_to')}</p>
          {d.pickup ? (
            <p className="text-emerald-ink">{t('goods_pickup_line')} · {d.city}, {d.state}</p>
          ) : (
            <p className="text-emerald-ink">{showPhone ? `${d.contact_name} · ${d.contact_phone} · ` : ''}{d.address}, {d.city}, {d.state} {d.pincode}</p>
          )}
        </div>
      )}
    </SheetCard>
  )
}
