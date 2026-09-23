import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/** v3 Stepper (PRD §3.6): labelled steps, never dots. `current` is 0-based. */
export function Stepper({ steps, current, ariaLabel, className }: { steps: string[]; current: number; ariaLabel: string; className?: string }) {
  return (
    <ol aria-label={ariaLabel} className={cn('flex items-start gap-2', className)}>
      {steps.map((s, i) => {
        const done = i < current
        const now = i === current
        return (
          <li key={s} aria-current={now ? 'step' : undefined} className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className={cn('h-1 rounded-chip', done || now ? 'bg-primary' : 'bg-foreground/10')} />
            <span className={cn('t-footnote inline-flex items-center gap-1 truncate', now ? 'font-semibold text-foreground' : done ? 'text-foreground-secondary' : 'text-foreground-tertiary')}>
              {done && <Check className="h-3 w-3 shrink-0 text-primary" strokeWidth={2.5} aria-hidden />}
              <span className="truncate">{s}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
