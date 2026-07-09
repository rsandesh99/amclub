import { cn } from '@/lib/utils'

interface ProgressProps {
  value: number
  max?: number
  className?: string
  label?: string
}

export function Progress({ value, max = 100, className, label }: ProgressProps) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100))

  return (
    <div className={cn('w-full', className)}>
      {label && (
        <div className="mb-1.5 flex justify-between text-xs text-foreground-secondary">
          <span>{label}</span>
          <span>{Math.round(pct)}%</span>
        </div>
      )}
      {/* Without a label the bar is decorative (steps/headings carry the info);
          exposing an unnamed progressbar role is an axe `serious`. */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden={label ? undefined : true}>
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${pct}%` }}
          {...(label
            ? {
                role: 'progressbar' as const,
                'aria-label': label,
                'aria-valuenow': value,
                'aria-valuemin': 0,
                'aria-valuemax': max,
              }
            : {})}
        />
      </div>
    </div>
  )
}
