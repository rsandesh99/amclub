import * as React from 'react'
import { cn } from '@/lib/utils'

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: string
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, ...props }, ref) => (
    <div className="flex flex-col gap-1">
      <textarea
        ref={ref}
        className={cn(
          'flex min-h-[88px] w-full resize-y rounded-button border border-border bg-surface px-3 py-2 text-sm text-foreground',
          'transition-colors placeholder:text-foreground-secondary',
          'focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25',
          'disabled:cursor-not-allowed disabled:opacity-50',
          error && 'border-danger focus:border-danger focus:ring-danger/25',
          className,
        )}
        aria-invalid={!!error}
        {...props}
      />
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  ),
)
Textarea.displayName = 'Textarea'
