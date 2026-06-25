import { useTranslations } from 'next-intl'
import { computePricing, formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * The canonical price block (§4.3). ONE component, used identically on cards
 * and detail pages — price transparency is the product's core promise.
 *
 *  - large discounted price (marigold-adjacent emphasis)
 *  - strikethrough list price when discounted
 *  - marigold "X% OFF" pill
 *  - member extra-discount line when configured
 */
export function PriceBlock({
  pricePaise,
  discountBps,
  memberExtraDiscountBps,
  size = 'card',
  className,
}: {
  pricePaise: number
  discountBps: number
  memberExtraDiscountBps: number
  size?: 'card' | 'detail'
  className?: string
}) {
  const t = useTranslations('catalog')
  const p = computePricing({ pricePaise, discountBps, memberExtraDiscountBps })
  const detail = size === 'detail'

  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span
          className={cn(
            'font-display font-bold tabular-nums text-foreground',
            detail ? 'text-2xl' : 'text-lg',
          )}
        >
          {formatINR(p.discountedPaise)}
        </span>
        {p.hasDiscount && (
          <>
            <span
              className={cn(
                'text-foreground-secondary line-through tabular-nums',
                detail ? 'text-base' : 'text-sm',
              )}
            >
              {formatINR(p.listPaise)}
            </span>
            <span className="rounded-chip bg-accent px-1.5 py-0.5 text-xs font-bold text-accent-foreground">
              {p.discountPct}% {t('off')}
            </span>
          </>
        )}
      </div>

      {p.hasMemberExtra && (
        <span className={cn('text-xs font-medium text-primary', detail && 'text-sm')}>
          {t('member_price', {
            price: formatINR(p.memberPaise),
            pct: p.memberExtraPct,
          })}
        </span>
      )}

      {detail && (
        <span className="mt-0.5 text-xs text-foreground-secondary">{t('price_incl_note')}</span>
      )}
    </div>
  )
}
