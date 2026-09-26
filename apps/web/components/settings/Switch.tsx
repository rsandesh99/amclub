'use client'

import { cn } from '@/lib/utils'

/**
 * An on/off switch (role="switch") for the settings screens: 44 px tall hit
 * area, visible focus ring, the state in aria-checked. Label it with
 * `aria-labelledby` (a visible title) and describe it with `aria-describedby`
 * (the notice text), so a screen reader reads exactly what the person agrees to.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  busy = false,
  labelledBy,
  describedBy,
  label,
  testId,
  className,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  busy?: boolean
  labelledBy?: string
  describedBy?: string
  /** Accessible name when there is no visible title to point at. */
  label?: string
  testId?: string
  className?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-label={labelledBy ? undefined : label}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      data-testid={testId}
      className={cn(
        'group relative inline-flex h-11 w-14 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <span className={cn('relative inline-flex h-7 w-12 items-center rounded-full transition-colors motion-reduce:transition-none', checked ? 'bg-primary' : 'bg-foreground/20')}>
        <span className={cn('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform motion-reduce:transition-none', checked ? 'translate-x-6' : 'translate-x-1', busy && 'animate-pulse')} />
      </span>
    </button>
  )
}
