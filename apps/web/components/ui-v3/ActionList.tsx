'use client'

import { useLocale, useTranslations } from 'next-intl'
import type { ActionItem } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { istDeadline } from '@/lib/dates'
import { GroupedSection, GroupedRow } from './GroupedList'

/**
 * v3 ActionList — "Needs your action" (N2 / N25): one row per item, one tap to
 * the exact object, deadline shown relative inside 48 h. Renders nothing when
 * empty (no empty-state illustration on a home screen).
 */
export function ActionList({ items, seeAllHref, max = 5 }: { items: ActionItem[]; seeAllHref?: string; max?: number }) {
  const t = useTranslations('next_action')
  const locale = useLocale()
  if (items.length === 0) return null
  const label = (it: ActionItem) => {
    if (it.kind === 'order_action' && it.action) return t(it.action)
    return t(it.kind, { count: it.count ?? 0, title: it.title })
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
          subtitle={it.kind === 'order_action' ? it.title : undefined}
          trailing={it.dueAt ? <span className="t-footnote shrink-0 text-foreground-secondary">{t('due', { when: istDeadline(it.dueAt, locale) })}</span> : undefined}
        />
      ))}
    </GroupedSection>
  )
}
