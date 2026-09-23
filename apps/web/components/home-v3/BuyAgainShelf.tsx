'use client'

import { useTranslations } from 'next-intl'
import type { BuyAgain } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { formatINR } from '@/lib/format'
import { useAnalytics } from '@/components/providers/posthog'
import { GroupedSection, GroupedRow } from '@/components/ui-v3/GroupedList'

/**
 * E9 FR-9.3 (N26) — "Buy again": up to 4 finished package orders. Prices are
 * the server's (`displayThen` = what the order charged, `displayNow` = what
 * checkout charges today); when they differ both show. A paused or removed
 * package offers "Find similar". Hidden when empty.
 */
export function BuyAgainShelf({ items }: { items: BuyAgain[] }) {
  const t = useTranslations('home_v3')
  const analytics = useAnalytics()
  if (items.length === 0) return null
  return (
    <div data-testid="home-buy-again">
      <GroupedSection header={t('buy_again_heading')}>
        {items.map((it) => {
          if (it.kind === 'package') {
            return (
              <GroupedRow
                key={it.orderId}
                href={it.href}
                onClick={() => analytics.capture('buy_again_clicked', { device: 'web', price_changed: it.priceChanged })}
                title={it.title}
                subtitle={
                  it.priceChanged
                    ? <span data-testid="buy-again-price-changed">{t('price_then_now', { then: formatINR(it.displayThen.taxablePaise), now: formatINR(it.displayNow.taxablePaise) })}</span>
                    : t('price_now', { now: formatINR(it.displayNow.taxablePaise) })
                }
                trailing={<span className="t-footnote shrink-0 rounded-chip bg-primary px-3 py-1 font-medium text-primary-foreground">{t('buy')}</span>}
                chevron={false}
              />
            )
          }
          if (it.kind === 'similar') {
            return (
              <GroupedRow
                key={it.orderId}
                href={it.searchHref}
                title={it.title}
                subtitle={t('unavailable')}
                trailing={<span className="t-footnote shrink-0 font-medium text-primary">{t('find_similar')}</span>}
                chevron={false}
              />
            )
          }
          return null
        })}
      </GroupedSection>
    </div>
  )
}

/** E9 FR-9.3 — the order page's "Buy again" / "Repeat requirement" / "Find similar" link (finished orders only). */
export function BuyAgainLink({ value }: { value: BuyAgain }) {
  const t = useTranslations('home_v3')
  const analytics = useAnalytics()
  const cls = 'inline-flex items-center rounded-button border border-border bg-surface px-4 py-2 text-sm font-medium hover:border-primary/40'
  if (value.kind === 'package') {
    return (
      <div className="flex flex-wrap items-center gap-3" data-testid="order-buy-again">
        <Link href={value.href as '/app'} onClick={() => analytics.capture('buy_again_clicked', { device: 'web', price_changed: value.priceChanged })} className={cls}>{t('buy_again')}</Link>
        <span className="t-footnote text-foreground-secondary">
          {value.priceChanged
            ? t('price_then_now', { then: formatINR(value.displayThen.taxablePaise), now: formatINR(value.displayNow.taxablePaise) })
            : t('price_now', { now: formatINR(value.displayNow.taxablePaise) })}
        </span>
      </div>
    )
  }
  if (value.kind === 'repeat') {
    return (
      <Link href={value.href as '/app'} onClick={() => analytics.capture('requirement_repeated', { device: 'web' })} className={cls} data-testid="order-repeat-requirement">
        {t('repeat_requirement')}
      </Link>
    )
  }
  return <Link href={value.searchHref as '/app'} className={cls} data-testid="order-find-similar">{t('find_similar')}</Link>
}
