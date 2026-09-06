import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'

export function istDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

/**
 * Molten-fill pool progress (FRONTEND.md §3.1 #4): liquid-gold fill against
 * the target with a brass tick at the minimum. Numbers come from the server
 * (`progress` is computed in lib/mart/pools.ts); this only draws them.
 */
export function PoolProgress({
  committedQty,
  targetQty,
  unit,
  progress,
  dark = false,
  className,
}: {
  committedQty: number
  targetQty: number
  unit: string
  progress: { pct: number; metPct: number; met: boolean; remainingToMin: number }
  dark?: boolean
  className?: string
}) {
  const t = useTranslations('mart')
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className={cn('relative h-3 w-full overflow-hidden rounded-chip', dark ? 'bg-ivory/15' : 'bg-emerald-ink/10')} role="progressbar" aria-valuenow={progress.pct} aria-valuemin={0} aria-valuemax={100} aria-label={t('pool_committed', { qty: committedQty, target: targetQty, unit })}>
        <div className="molten-fill" style={{ width: `${progress.pct}%` }} />
        <span className={cn('absolute top-0 h-full w-0.5', dark ? 'bg-ivory/70' : 'bg-brass')} style={{ left: `${progress.metPct}%` }} aria-hidden="true" />
      </div>
      <div className={cn('flex flex-wrap items-baseline justify-between gap-x-3 text-meta', dark ? 'text-ivory/85' : 'text-emerald-ink')}>
        <span className="font-semibold tabular-nums">{t('pool_committed', { qty: committedQty, target: targetQty, unit })}</span>
        <span className={cn('text-xs', dark ? 'text-ivory/70' : 'text-foreground-secondary')}>
          {progress.met ? t('pool_met_line') : t('pool_remaining', { qty: progress.remainingToMin, unit })}
        </span>
      </div>
    </div>
  )
}
