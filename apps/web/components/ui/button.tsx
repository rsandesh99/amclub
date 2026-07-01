'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** `accent` (marigold) is for use ON the green hero only (§4.2). */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'accent'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  /** Optional leading icon (e.g. an <Icon /> element). */
  iconLeft?: React.ReactNode
  /** Optional trailing icon (e.g. an arrow). */
  iconRight?: React.ReactNode
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  iconLeft,
  iconRight,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-button font-medium ' +
    'transition duration-150 ease-out ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
    'disabled:pointer-events-none disabled:opacity-50 ' +
    'motion-safe:active:scale-[0.98]'

  const variants = {
    // Primary carries subtle depth + deepens to primary-strong on interaction.
    primary: 'bg-primary text-white shadow-xs hover:bg-primary-strong hover:shadow-hover active:bg-primary-strong active:shadow-pressed',
    secondary: 'bg-primary/10 text-primary hover:bg-primary/[0.16] active:bg-primary/20',
    outline: 'border border-primary text-primary hover:bg-primary/10 active:bg-primary/15',
    ghost: 'text-primary hover:bg-primary/10 active:bg-primary/15',
    danger: 'bg-danger text-white shadow-xs hover:bg-danger/90 hover:shadow-hover active:bg-danger active:shadow-pressed',
    // Marigold action — ONLY on the green hero (never a general CTA).
    accent: 'bg-accent text-accent-foreground shadow-xs hover:bg-accent/90 hover:shadow-hover active:shadow-pressed',
  }

  const sizes = {
    sm: 'h-9 px-3 text-sm',
    md: 'h-11 px-5 text-sm',
    lg: 'h-12 px-6 text-base',
  }

  return (
    <button
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <svg
          className="h-4 w-4 animate-spin"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      )}
      {!loading && iconLeft}
      {children}
      {!loading && iconRight}
    </button>
  )
}
