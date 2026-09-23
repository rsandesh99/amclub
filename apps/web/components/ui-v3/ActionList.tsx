'use client'

import { useLocale, useTranslations } from 'next-intl'
import type { ActionItem } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { istDeadline } from '@/lib/dates'
import { formatINR } from '@/lib/format'
import { useAnalytics } from '@/components/providers/posthog'
import { GroupedSection, GroupedRow } from './GroupedList'

/**
 * v3 ActionList — "Needs your action" (N2 / N25): one row per item, one tap to
 * the exact object, deadline shown relative inside 48 h. Renders nothing when
 * empty (no empty-state illustration on a home screen).
 */
export function ActionList({ items, seeAllHref, max = 5, trackEvent }: { items: ActionItem[]; seeAllHref?: string; max?: number; trackEvent?: string }) {
  const t = useTranslations('next_action')
  const locale = useLocale()
  const analytics = useAnalytics()
  if (items.length === 0) return null
  const label = (it: ActionItem) => {
    if (it.kind === 'order_action' && it.action) return t(it.action)
    // E9 — "Quote from Rao Associates expires Fri".
    if (it.kind === 'quote_expiring') return t('quote_expiring', { provider: it.providerName, when: it.dueAt ? istDeadline(it.dueAt, locale) : '' })
    return t(it.kind, { count: it.count ?? 0, title: it.title })
  }
  const subtitle = (it: ActionItem) => {
    if (it.kind === 'order_action' || it.kind === 'quote_expiring') return it.title
    // E9 — "from ₹5,310 all-in · compare" (the server's lowest normalised total).
    if (it.kind === 'quotes_waiting' && it.fromPaise != null) return t('quotes_from', { price: formatINR(it.fromPaise) })
    return undefined
  }
  return (
    <GroupedSection
      header={`${t('needs_your_action')} · ${items.length}`}
      action={seeAllHref && items.length > max ? <Link href={seeAllHref as '/app'} className="t-footnote font-medium text-primary">{t('see_all')}</Link> : undefined}
    >
      {items.slice(0, max).map((it) => (
        <GroupedRow
          key={`${it.kind}-${it.objectId}`}
          href={it.href}
          leading={<span aria-hidden className="h-2 w-2 rounded-full bg-primary" />}
          title={label(it)}
          subtitle={subtitle(it)}
          {...(trackEvent ? { onClick: () => analytics.capture(trackEvent, { device: 'web', kind: it.kind === 'order_action' && it.action ? it.action : it.kind }) } : {})}
          trailing={it.dueAt && it.kind !== 'quote_expiring' ? <span className="t-footnote shrink-0 text-foreground-secondary">{t('due', { when: istDeadline(it.dueAt, locale) })}</span> : undefined}
        />
      ))}
    </GroupedSection>
  )
}
