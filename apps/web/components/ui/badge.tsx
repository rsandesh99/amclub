import { cn } from '@/lib/utils'

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'accent' | 'outline'

interface BadgeProps {
  variant?: BadgeVariant
  className?: string
  children: React.ReactNode
}

// Pre-mixed soft-tint fills (§4.2) — consistent contrast, no per-badge rgba().
const variants: Record<BadgeVariant, string> = {
  default: 'bg-primary-soft text-primary',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-verified-soft text-verified',
  accent: 'bg-accent font-bold text-accent-foreground',
  outline: 'border border-border text-foreground-secondary',
}

export function Badge({ variant = 'default', className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        variants[variant],
        className,
      )}
    >
      {children}
    </span>
  )
}
