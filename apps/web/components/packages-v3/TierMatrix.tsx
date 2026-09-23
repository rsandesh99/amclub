'use client'

import { useEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Minus } from 'lucide-react'
import type { CompareValue, PackageTier, PriceDisplay } from '@amclub/shared'
import { formatINR } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useAnalytics } from '@/components/providers/posthog'
import { useTierState } from './TierContext'

export interface MatrixColumn {
  id: string
  tier: PackageTier
  values: Record<string, CompareValue>
  deliveryDays: number
  display: PriceDisplay
}

/**
 * FR-4.1 comparison matrix — ≤ 12 provider rows, then delivery and the price
 * (server display). Phones see two tiers at a time and swipe for the third;
 * the row labels stay pinned. Used by the package page and, as the live
 * preview, by the tier editor.
 */
export function TierMatrix({
  rows,
  columns,
  selectedId,
  onSelect,
  mostChosen,
  className,
}: {
  rows: { key: string; label: string }[]
  columns: MatrixColumn[]
  selectedId?: string
  onSelect?: (id: string) => void
  mostChosen?: PackageTier | null
  className?: string
}) {
  const t = useTranslations('packages_v3')
  const cell = (v: CompareValue | undefined) => {
    if (v === true) return <Check className="mx-auto h-4 w-4 text-success" aria-label={t('included')} />
    if (v === false || v === undefined) return <Minus className="mx-auto h-4 w-4 text-foreground-tertiary" aria-label={t('not_included')} />
    return <span>{v}</span>
  }
  const colClass = (id: string) =>
    cn('min-w-[38vw] px-3 py-2.5 text-center sm:min-w-0', id === selectedId && 'bg-primary/5')

  return (
    <div className={cn('-mx-4 snap-x overflow-x-auto px-4 sm:mx-0 sm:px-0', className)}>
      <table className="w-full border-separate border-spacing-0 text-sm" data-testid="tier-matrix">
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-10 min-w-[8rem] bg-surface px-3 py-2.5 text-left font-normal text-foreground-secondary">
              <span className="sr-only">{t('feature')}</span>
            </th>
            {columns.map((c) => (
              <th key={c.id} scope="col" className={cn(colClass(c.id), 'snap-start border-b border-separator align-bottom')}>
                {mostChosen === c.tier && (
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-primary" data-testid="most-chosen">
                    {t('most_chosen')}
                  </span>
                )}
                {onSelect ? (
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    aria-pressed={c.id === selectedId}
                    className="min-h-[44px] w-full rounded-button font-semibold hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    {t(`tier_${c.tier}`)}
                  </button>
                ) : (
                  <span className="font-semibold">{t(`tier_${c.tier}`)}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" className="sticky left-0 z-10 border-b border-separator bg-surface px-3 py-2.5 text-left font-normal">
                {r.label}
              </th>
              {columns.map((c) => (
                <td key={c.id} className={cn(colClass(c.id), 'border-b border-separator')}>{cell(c.values[r.key])}</td>
              ))}
            </tr>
          ))}
          <tr>
            <th scope="row" className="sticky left-0 z-10 border-b border-separator bg-surface px-3 py-2.5 text-left font-normal">
              {t('row_delivery')}
            </th>
            {columns.map((c) => (
              <td key={c.id} className={cn(colClass(c.id), 'border-b border-separator tabular-nums')}>
                {t('days', { days: c.deliveryDays })}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-2.5 text-left font-normal">{t('row_price')}</th>
            {columns.map((c) => (
              <td key={c.id} className={cn(colClass(c.id), 'font-semibold tabular-nums')}>
                {t('price_plus_gst', { price: formatINR(c.display.taxablePaise) })}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  )
}

/** The package page's matrix: bound to the tier selection, reports one view. */
export function PackageTierMatrix({ rows }: { rows: { key: string; label: string }[] }) {
  const { options, selected, select, mostChosen } = useTierState()
  const analytics = useAnalytics()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        analytics.capture('compare_matrix_viewed', { device: 'web' })
        io.disconnect()
      }
    }, { threshold: 0.4 })
    io.observe(el)
    return () => io.disconnect()
  }, [analytics])
  return (
    <div ref={ref}>
      <TierMatrix
        rows={rows}
        columns={options.filter((o) => o.tier).map((o) => ({ id: o.packageId, tier: o.tier!, values: o.compareValues, deliveryDays: o.deliveryDays, display: o.display }))}
        selectedId={selected.packageId}
        onSelect={select}
        mostChosen={mostChosen}
      />
    </div>
  )
}
