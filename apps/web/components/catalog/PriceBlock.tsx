import { useTranslations } from 'next-intl'
import { gstPercent, type PriceDisplay } from '@amclub/shared'
import { formatINR, formatINRExact } from '@/lib/format'
import { cn } from '@/lib/utils'
import { MEMBER_PRICING_ENABLED } from '@/lib/public-flags'
import { ItcLine } from './ItcLine'

/**
 * The canonical price block (§4.3). ONE component, used identically on cards
 * and detail pages — price transparency is the product's core promise.
 *
 * Experience v3 N16 (FR-4.3): it renders ONLY the server's `display` (shared
 * priceDisplay → computeOrderAmounts, the function checkout charges with). It
 * never adds, subtracts or multiplies money.
 *
 *  - large price (taxable value), strikethrough list price + "X% OFF" pill
 *    when discounted
 *  - member extra-discount line when configured AND memberships are live
 *    (MEMBER_PRICING_ENABLED — off until checkout can honour it; E0 / U2)
 *  - `equation` (flag `packages`): cards read "₹1,499 + GST"; the detail reads
 *    "₹1,499 + 18 % GST = ₹1,768.82", and a GST-registered buyer also sees
 *    "claim ₹269.82 as ITC".
 */
export function PriceBlock({
  display,
  size = 'card',
  equation = false,
  className,
}: {
  display: PriceDisplay
  size?: 'card' | 'detail'
  equation?: boolean
  className?: string
}) {
  const t = useTranslations('catalog')
  const detail = size === 'detail'
  const hasDiscount = display.discountPct > 0

  return (
    <div className={cn('flex flex-col gap-0.5', className)} data-price-display={equation ? 'v3' : undefined}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span
          className={cn(
            'font-display font-bold leading-none tracking-tight tabular-nums text-foreground',
            detail ? 'text-3xl' : 'text-xl',
          )}
        >
          {equation && !detail ? t('price_plus_gst', { price: formatINR(display.taxablePaise) }) : formatINR(display.taxablePaise)}
        </span>
        {hasDiscount && (
          <>
            <span
              className={cn(
                'text-foreground-secondary line-through tabular-nums',
                detail ? 'text-md' : 'text-sm',
              )}
            >
              {formatINR(display.listPaise)}
            </span>
            <span className="rounded-chip bg-accent px-2 py-0.5 text-xs font-bold tabular-nums text-accent-foreground shadow-xs">
              {display.discountPct}% {t('off')}
            </span>
          </>
        )}
      </div>

      {MEMBER_PRICING_ENABLED && display.memberPaise !== null && (
        <span className={cn('text-xs font-medium text-primary', detail && 'text-sm')}>
          {t('member_price', {
            price: formatINR(display.memberPaise),
            pct: display.memberExtraPct,
          })}
        </span>
      )}

      {detail && equation && (
        <span className="mt-1 text-sm tabular-nums text-foreground-secondary" data-testid="price-equation">
          {t('price_equation', {
            price: formatINRExact(display.taxablePaise),
            pct: gstPercent(display.gstBps),
            total: formatINRExact(display.totalPaise),
          })}
          <ItcLine gstPaise={display.itcPaise ?? display.gstPaise} known={display.itcPaise !== null} />
        </span>
      )}

      {detail && !equation && (
        <span className="mt-0.5 text-xs text-foreground-secondary">{t('price_incl_note')}</span>
      )}
    </div>
  )
}
