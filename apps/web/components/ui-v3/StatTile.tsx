import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * v3 StatTile / StatChip (PRD §3.6, content rule §3.7): a measured number
 * always carries its sample ("96 % on time · 48 orders"). Tabular numerals.
 * Screen readers get one sentence (`srLabel`) instead of the fragments.
 */
export function StatTile({ value, label, note, srLabel, className }: { value: ReactNode; label: ReactNode; note?: ReactNode; srLabel?: string; className?: string }) {
  return (
    <div className={cn('rounded-card bg-surface px-3 py-3 shadow-xs', className)}>
      <div aria-hidden={srLabel ? true : undefined}>
        <p className="t-money-m text-numeric">{value}</p>
        <p className="t-footnote mt-0.5 text-foreground-secondary">{label}</p>
        {note && <p className="t-footnote text-foreground-tertiary">{note}</p>}
      </div>
      {srLabel && <p className="sr-only">{srLabel}</p>}
    </div>
  )
}

export function StatChip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('t-footnote inline-flex items-center gap-1 rounded-chip bg-foreground/5 px-2 py-0.5 font-medium tabular-nums text-foreground-secondary', className)}>{children}</span>
}
