import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

/** v3 EmptyState — calm, one line of help, one action. No illustrations on data screens. */
export function EmptyState({ title, body, action, className }: { title: ReactNode; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-2 rounded-card bg-surface px-6 py-10 text-center shadow-xs', className)}>
      <p className="t-headline text-foreground">{title}</p>
      {body && <p className="t-subhead max-w-sm text-foreground-secondary">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

/** v3 Skeleton — replaces spinners (PRD §3.2). Static under reduced motion. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-[6px] bg-foreground/[0.06] motion-reduce:animate-none', className)} />
}

const BANNER = {
  info: { icon: Info, cls: 'bg-primary-soft text-foreground' },
  caution: { icon: AlertTriangle, cls: 'bg-warning-soft text-warning' },
  critical: { icon: OctagonAlert, cls: 'bg-danger-soft text-danger' },
  positive: { icon: CheckCircle2, cls: 'bg-success-soft text-success' },
} as const

/** v3 Banner — one message, one optional action. `critical` is for errors and disputes only. */
export function Banner({ tone = 'info', title, children, action, className }: { tone?: keyof typeof BANNER; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  const { icon: Icon, cls } = BANNER[tone]
  return (
    <div role={tone === 'critical' ? 'alert' : 'status'} className={cn('flex items-start gap-3 rounded-card px-4 py-3', cls, className)}>
      <Icon className="mt-0.5 h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5', 'text-foreground')}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

/** Count badge for nav items (N2). Hidden at 0; "99+" above 99. */
export function CountBadge({ count, label, className }: { count: number; label?: string; className?: string }) {
  if (!count) return null
  return (
    <span aria-label={label} className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded-chip bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground', className)}>
      {count > 99 ? '99+' : count}
    </span>
  )
}
