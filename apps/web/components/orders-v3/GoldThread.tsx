'use client'

import { useTranslations } from 'next-intl'
import { GOLD_THREAD_STEPS, goldThread } from '@amclub/shared'
import { cn } from '@/lib/utils'

/**
 * PRD Experience v3 E8 — the Gold Thread: Paid → Accepted → Work → Delivered →
 * Done, filled to the furthest step the order reached (shared `goldThread`).
 * Off the happy path the branch (dispute, cancelled, refunded, resolved) is
 * named under the thread instead of pretending the order finished.
 */
export function GoldThread({ status, eventNames }: { status: string; eventNames: readonly string[] }) {
  const t = useTranslations('orders_v3')
  const { reached, branch } = goldThread(status, eventNames)
  return (
    <div data-testid="gold-thread" data-reached={reached}>
      <ol className="flex items-start" aria-label={t('thread_label')}>
        {GOLD_THREAD_STEPS.map((step, i) => {
          const done = i <= reached
          return (
            <li key={step} className="relative flex flex-1 flex-col items-center text-center" aria-current={i === reached ? 'step' : undefined}>
              {i > 0 && <span aria-hidden className={cn('absolute right-1/2 top-[7px] h-0.5 w-full', i <= reached ? 'bg-accent' : 'bg-border')} />}
              <span aria-hidden className={cn('relative z-[1] h-4 w-4 rounded-full border-2', done ? 'border-accent bg-accent' : 'border-border bg-surface')} />
              <span className={cn('mt-1.5 text-[11px]', done ? 'font-medium text-foreground' : 'text-foreground-secondary')}>
                {t(`step_${step}`)}
                <span className="sr-only">{done ? ` — ${t('step_reached')}` : ''}</span>
              </span>
            </li>
          )
        })}
      </ol>
      {branch && <p className="mt-3 text-sm text-foreground-secondary" data-testid="gold-thread-branch">{t(`branch_${branch}`)}</p>}
    </div>
  )
}
