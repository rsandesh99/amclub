import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Compact rating: filled star + numeric rating + optional review count. */
export function Stars({
  rating,
  count,
  className,
}: {
  rating: number
  count?: number
  className?: string
}) {
  if (!rating || rating <= 0) {
    return <span className={cn('text-xs text-foreground-secondary', className)}>New</span>
  }
  return (
    <span className={cn('inline-flex items-center gap-1 text-sm', className)}>
      <Star className="h-3.5 w-3.5 fill-accent text-accent" aria-hidden />
      <span className="font-semibold tabular-nums">{rating.toFixed(1)}</span>
      {count !== undefined && count > 0 && (
        <span className="text-xs text-foreground-secondary">({count})</span>
      )}
    </span>
  )
}
