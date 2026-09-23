'use client'

import * as React from 'react'
import { Button } from './button'

/**
 * The ONE confirm surface for irreversible or money-moving actions
 * (docs/UX_QUALITY_AUDIT.md Part B #7). Bottom sheet on phones, centred dialog
 * on larger screens. It renders no copy of its own — every label comes from the
 * caller through next-intl — and never computes money: callers pass
 * server-computed amounts inside `children`.
 *
 * Escape and the backdrop close it (unless busy); focus moves into the sheet on
 * open and returns to the opener on close.
 */
export function ConfirmSheet({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onClose,
  busy = false,
  error,
  variant = 'primary',
  confirmDisabled = false,
  children,
}: {
  open: boolean
  title: string
  description?: React.ReactNode
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void | Promise<void>
  onClose: () => void
  busy?: boolean
  error?: string | null
  variant?: 'primary' | 'danger'
  confirmDisabled?: boolean
  children?: React.ReactNode
}) {
  const titleId = React.useId()
  const panelRef = React.useRef<HTMLDivElement>(null)
  const openerRef = React.useRef<Element | null>(null)

  React.useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (openerRef.current instanceof HTMLElement) openerRef.current.focus()
    }
  }, [open, busy, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg rounded-t-card border border-border bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-card outline-none sm:rounded-card"
      >
        <h3 id={titleId} className="font-display text-lg font-bold">{title}</h3>
        {description && <div className="mt-2 text-sm text-foreground-secondary">{description}</div>}
        {children && <div className="mt-4">{children}</div>}
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>{cancelLabel}</Button>
          <Button variant={variant} onClick={() => void onConfirm()} loading={busy} disabled={confirmDisabled}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
