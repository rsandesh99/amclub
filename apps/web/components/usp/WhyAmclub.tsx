'use client'

import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  ArrowRight, BadgeCheck, Bell, Camera, Clock, Columns3, Inbox, IndianRupee, Languages, Lock, MessageCircle, Mic,
  NotebookPen, Package, PhoneOff, Receipt, Scale, ScrollText, Sparkles, Star, Target, Users, Wallet,
} from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { useAnalytics } from '@/components/providers/posthog'
import { cn } from '@/lib/utils'
import { uspsFor, type UspIcon } from '@/lib/usp'

const ICONS: Record<UspIcon, typeof Mic> = {
  phoneOff: PhoneOff, mic: Mic, scroll: ScrollText, inbox: Inbox, columns: Columns3, lock: Lock, badgeCheck: BadgeCheck,
  receipt: Receipt, rupee: IndianRupee, scale: Scale, languages: Languages, message: MessageCircle, package: Package,
  target: Target, users: Users, wallet: Wallet, notebook: NotebookPen, camera: Camera, star: Star, bell: Bell, clock: Clock,
}

type Audience = 'buyers' | 'providers'

/**
 * E18 "Why AMClub": the product's promises in one panel, with two tabs:
 * For buyers | For providers. Each tab lists every item for that audience (the
 * provider tab is the full provider pitch). Rendered as the right rail of the
 * buyer home and beside the /services and /mart front pages (flag `guide`).
 * `collapsed` shows the first few items with "Show all" (phones and narrow rails).
 */
export function WhyAmclub({
  surface,
  martEnabled,
  defaultTab = 'buyers',
  collapsedCount = 6,
  tone = 'default',
  className,
}: {
  surface: 'home' | 'services' | 'mart'
  martEnabled: boolean
  defaultTab?: Audience
  collapsedCount?: number
  tone?: 'default' | 'mart'
  className?: string
}) {
  const t = useTranslations('why_amclub')
  const analytics = useAnalytics()
  const id = useId()
  const [tab, setTab] = useState<Audience>(defaultTab)
  const [expanded, setExpanded] = useState(false)
  const items = uspsFor(tab, martEnabled)
  const shown = expanded ? items : items.slice(0, collapsedCount)

  function pick(next: Audience) {
    if (next === tab) return
    setTab(next)
    setExpanded(next === 'providers')
    analytics.capture('why_amclub_tab_switched', { surface, tab: next })
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(
        'rounded-card border bg-surface p-4 shadow-card',
        tone === 'mart' ? 'border-brass/40' : 'border-border',
        className,
      )}
      data-testid="why-amclub"
      data-tab={tab}
    >
      <h2 id={`${id}-title`} className="t-headline flex items-center gap-2 text-foreground">
        <Sparkles className="h-4 w-4 text-primary" aria-hidden /> {t('title')}
      </h2>

      <div role="tablist" aria-label={t('title')} className="mt-3 grid grid-cols-2 gap-1 rounded-button bg-foreground/5 p-1">
        {(['buyers', 'providers'] as const).map((a) => (
          <button
            key={a}
            type="button"
            role="tab"
            id={`${id}-tab-${a}`}
            aria-selected={tab === a}
            aria-controls={`${id}-panel`}
            tabIndex={tab === a ? 0 : -1}
            onClick={() => pick(a)}
            onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); pick(a === 'buyers' ? 'providers' : 'buyers') } }}
            className={cn(
              'h-9 rounded-[8px] text-[13px] font-semibold transition-colors',
              tab === a ? 'bg-surface text-foreground shadow-xs' : 'text-foreground-secondary hover:text-foreground',
            )}
            data-testid={`why-amclub-tab-${a}`}
          >
            {t(`tab_${a}`)}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} className="mt-3">
        <p className="t-footnote text-foreground-secondary">{t(`lead_${tab}`)}</p>
        <ul className="mt-3 space-y-3" data-testid="why-amclub-items" data-count={items.length}>
          {shown.map((it) => {
            const Icon = ICONS[it.icon]
            return (
              <li key={it.key} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5 text-[14px] font-semibold leading-snug text-foreground">
                    {t(`${tab}.${it.key}.title`)}
                    {it.ai && <span className="rounded-chip bg-primary/10 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-primary">{t('ai_chip')}</span>}
                  </span>
                  <span className="t-footnote mt-0.5 block text-foreground-secondary">{t(`${tab}.${it.key}.body`)}</span>
                </span>
              </li>
            )
          })}
        </ul>
        {items.length > shown.length && (
          // Its own row (block): inline, it sat on the CTA's line, jammed against "Post a requirement".
          <button type="button" onClick={() => setExpanded(true)} className="mt-3 block text-[13px] font-semibold text-primary hover:underline">
            {t('show_all', { count: items.length })}
          </button>
        )}
        {items.some((i) => i.ai) && <p className="t-caption mt-3 text-foreground-secondary">{t('ai_note')}</p>}
        <Link
          href={tab === 'buyers' ? '/app/rfq/new?entry=why' : '/partner/onboarding'}
          onClick={() => analytics.capture('why_amclub_cta_clicked', { surface, tab })}
          className="mt-4 inline-flex min-h-10 items-center gap-1 rounded-button bg-primary px-4 text-[13px] font-semibold text-primary-foreground hover:bg-primary-strong"
        >
          {t(`cta_${tab}`)} <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </section>
  )
}
