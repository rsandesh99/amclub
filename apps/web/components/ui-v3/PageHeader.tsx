'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { cn } from '@/lib/utils'

/**
 * v3 NavBar + large title (PRD §3.3 C1): the page title renders large in the
 * content; once it scrolls under the top, a translucent compact bar shows it
 * instead. Back link and ≤ 2 trailing actions.
 */
export function PageHeader({
  title,
  subtitle,
  backHref,
  actions,
  className,
}: {
  title: ReactNode
  subtitle?: ReactNode
  backHref?: string
  actions?: ReactNode
  className?: string
}) {
  const t = useTranslations('ui')
  const sentinel = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    const el = sentinel.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setCollapsed(!e!.isIntersecting), { rootMargin: '-64px 0px 0px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <>
      <div
        aria-hidden={!collapsed}
        className={cn(
          'material hairline-b fixed inset-x-0 top-0 z-20 flex h-14 items-center gap-2 px-4 transition-opacity duration-200',
          collapsed ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        {backHref && (
          <Link href={backHref as '/app'} aria-label={t('back')} tabIndex={collapsed ? 0 : -1} className="-ml-2 inline-flex h-11 w-11 items-center justify-center rounded-full text-primary">
            <ChevronLeft className="h-6 w-6" strokeWidth={1.75} />
          </Link>
        )}
        <p className="t-headline min-w-0 flex-1 truncate text-center text-foreground">{title}</p>
        {backHref && <span className="w-9" />}
      </div>
      <div className={cn('flex items-end justify-between gap-3', className)}>
        <div className="min-w-0">
          {backHref && (
            <Link href={backHref as '/app'} className="t-callout -ml-1 mb-1 inline-flex items-center gap-0.5 text-primary">
              <ChevronLeft className="h-5 w-5" strokeWidth={1.75} aria-hidden />
              {t('back')}
            </Link>
          )}
          <h1 className="t-large-title text-foreground">{title}</h1>
          {subtitle && <p className="t-subhead mt-1 text-foreground-secondary">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div ref={sentinel} aria-hidden className="h-px" />
    </>
  )
}
