import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { cn } from '@/lib/utils'

/**
 * v3 inset grouped list (PRD §3.3 C2): rows on a raised rounded group with
 * hairlines between them, a footnote-style section header and optional
 * footer. Row height follows the density (`--row-h`).
 */
export function GroupedSection({ header, footer, action, children, className }: { header?: ReactNode; footer?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-1.5', className)}>
      {(header || action) && (
        <div className="flex items-baseline justify-between px-4">
          {header && <h2 className="t-footnote font-medium text-foreground-secondary">{header}</h2>}
          {action}
        </div>
      )}
      <div className="grouped">{children}</div>
      {footer && <p className="t-footnote px-4 text-foreground-secondary">{footer}</p>}
    </section>
  )
}

export function GroupedRow({
  href,
  onClick,
  leading,
  title,
  subtitle,
  value,
  trailing,
  chevron,
  tone,
  className,
}: {
  href?: string
  onClick?: () => void
  leading?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  value?: ReactNode
  trailing?: ReactNode
  chevron?: boolean
  tone?: 'default' | 'critical'
  className?: string
}) {
  const body = (
    <>
      {leading && <span className="flex shrink-0 items-center text-foreground-secondary">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-[15px] font-medium', tone === 'critical' ? 'text-danger' : 'text-foreground')}>{title}</span>
        {subtitle && <span className="t-subhead mt-0.5 block truncate text-foreground-secondary">{subtitle}</span>}
      </span>
      {value !== undefined && <span className="t-numeric-s shrink-0 text-right text-numeric">{value}</span>}
      {trailing}
      {(chevron ?? !!href) && <ChevronRight className="h-4 w-4 shrink-0 text-foreground-tertiary" strokeWidth={1.75} aria-hidden />}
    </>
  )
  const cls = cn('grouped-row flex w-full items-center gap-3 px-4 text-left', (href || onClick) && 'transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary', className)
  if (href) return <Link href={href as '/app'} className={cls}>{body}</Link>
  if (onClick) return <button type="button" onClick={onClick} className={cls}>{body}</button>
  return <div className={cls}>{body}</div>
}
