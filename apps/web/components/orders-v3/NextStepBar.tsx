'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { MoreHorizontal } from 'lucide-react'
import type { NextAction } from '@amclub/shared'
import { Button } from '@/components/ui/button'

export interface BarAction {
  key: string
  label: string
  onSelect: () => void
  loading?: boolean
  danger?: boolean
}

function istWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

/**
 * PRD Experience v3 E8 FR-8.2 — the sticky bar under the order title: the ONE
 * next step (shared `nextAction`), its deadline and what happens if it passes,
 * the primary action, and everything else (revision, report a problem, cancel,
 * remind) in an overflow menu. It only renders buttons the workspace already
 * offers (`actionsFor`); the server stays the authority on every move.
 */
export function NextStepBar({ next, primary, secondary }: { next: NextAction | null; primary: BarAction | null; secondary: BarAction[] }) {
  const t = useTranslations('next_action')
  const to = useTranslations('orders_v3')
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  if (!next && !primary && secondary.length === 0) return null
  const label = next ? t(next.action) : to('nothing_next')
  return (
    <div className="material hairline-b sticky top-14 z-20 -mx-4 px-4 py-3" data-testid="order-next-step-bar" data-next={next?.action ?? 'none'}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            <span className="text-foreground-secondary">{to('next_label')} </span>
            {label}
            {next?.dueAt && <span className="font-normal text-foreground-secondary"> · {t('due', { when: istWhen(next.dueAt) })}</span>}
          </p>
          {next?.consequence && next.dueAt && <p className="t-footnote text-foreground-secondary">{t(`consequence_${next.consequence}`)}</p>}
        </div>
        {primary && (
          <Button size="sm" onClick={primary.onSelect} loading={primary.loading ?? false} variant={primary.danger ? 'danger' : 'primary'}>
            {primary.label}
          </Button>
        )}
        {secondary.length > 0 && (
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label={to('more_actions')}
              className="flex h-9 w-9 items-center justify-center rounded-button text-foreground-secondary hover:bg-sunken"
            >
              <MoreHorizontal className="h-5 w-5" aria-hidden />
            </button>
            {open && (
              <ul role="menu" className="absolute right-0 z-30 mt-1 min-w-48 rounded-card bg-surface p-1 shadow-card">
                {secondary.map((a) => (
                  <li key={a.key} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { setOpen(false); a.onSelect() }}
                      className={`block w-full rounded-button px-3 py-2 text-left text-sm hover:bg-sunken ${a.danger ? 'text-danger' : ''}`}
                    >
                      {a.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
