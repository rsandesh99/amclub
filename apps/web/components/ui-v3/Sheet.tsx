'use client'

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * v3 Sheet (PRD §3.3 C3 / §3.6) — a sheet with detents that keeps context.
 * Phones: slides up from the bottom (medium ≈ half, large ≈ full), drag the
 * handle down to dismiss. ≥ sm: a centred panel. Focus is trapped inside and
 * returned to the trigger on close; Escape and the backdrop close it.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  detent = 'medium',
  footer,
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  detent?: 'medium' | 'large'
  footer?: ReactNode
  children: ReactNode
  className?: string
}) {
  const t = useTranslations('ui')
  const [mounted, setMounted] = useState(false)
  const [visible, setVisible] = useState(false)
  const [drag, setDrag] = useState(0)
  const panel = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)
  const dragStart = useRef<number | null>(null)
  const titleId = useId()
  const descId = useId()

  // Mount → next frame visible (enter transition); close → transition out → unmount.
  useEffect(() => {
    if (open) {
      restoreTo.current = document.activeElement as HTMLElement | null
      setMounted(true)
      const raf = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(raf)
    }
    setVisible(false)
    const tm = setTimeout(() => setMounted(false), 300)
    return () => clearTimeout(tm)
  }, [open])

  useEffect(() => {
    if (!mounted) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const first = panel.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    return () => {
      document.body.style.overflow = prev
      restoreTo.current?.focus?.()
    }
  }, [mounted])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
    if (e.key !== 'Tab' || !panel.current) return
    const els = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
    if (els.length === 0) return
    const first = els[0]!, last = els[els.length - 1]!
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }, [onClose])

  if (!mounted || typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-50" onKeyDown={onKeyDown}>
      <div
        aria-hidden
        onClick={onClose}
        className={cn('sheet-backdrop absolute inset-0 bg-foreground/35', visible ? 'opacity-100' : 'opacity-0')}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        // Only while a phone drag is in progress: an inline transform replaces the
        // translate classes, and on ≥ sm those classes are what centre the panel.
        style={drag > 0 ? { transform: `translateY(${drag}px)` } : undefined}
        className={cn(
          'sheet-panel absolute inset-x-0 bottom-0 flex flex-col bg-surface shadow-modal',
          'rounded-t-sheet sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:-translate-x-1/2 sm:rounded-sheet',
          detent === 'large' ? 'max-h-[92dvh] sm:max-h-[85vh] sm:max-w-2xl' : 'max-h-[60dvh] sm:max-h-[70vh] sm:max-w-md',
          visible ? 'translate-y-0 opacity-100 sm:-translate-y-1/2' : 'translate-y-full opacity-0 sm:-translate-y-[45%]',
          className,
        )}
      >
        {/* Drag handle (phones) — drag down ≥ 80 px to dismiss. */}
        <div
          className="flex cursor-grab touch-none justify-center pb-1 pt-2 sm:hidden"
          onPointerDown={(e) => { dragStart.current = e.clientY; (e.target as HTMLElement).setPointerCapture(e.pointerId) }}
          onPointerMove={(e) => { if (dragStart.current !== null) setDrag(Math.max(0, e.clientY - dragStart.current)) }}
          onPointerUp={() => { const d = drag; dragStart.current = null; setDrag(0); if (d > 80) onClose() }}
          aria-hidden
        >
          <span className="h-1.5 w-10 rounded-chip bg-foreground/20" />
        </div>
        <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-2 sm:pt-5">
          <div className="min-w-0">
            <h2 id={titleId} className="t-title-3 text-foreground">{title}</h2>
            {description && <p id={descId} className="t-subhead mt-1 text-foreground-secondary">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground-secondary hover:bg-foreground/5"
          >
            <X className="h-5 w-5" strokeWidth={1.75} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">{children}</div>
        {footer && (
          <div className="hairline-t px-5 pt-3" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
