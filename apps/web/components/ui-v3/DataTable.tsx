import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface Column<T> {
  key: string
  header: ReactNode
  /** Numbers right-aligned in tabular numerals (§3.3 B). */
  align?: 'left' | 'right'
  className?: string
  render: (row: T) => ReactNode
}

/**
 * v3 DataTable (PRD §3.6): real <table> semantics with scoped headers, a
 * sticky header row and (optionally) a sticky first column, hairline rows,
 * density-aware row height (`--row-h-data`; Compact = 36 px).
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  stickyFirstColumn = false,
  empty,
  className,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  caption: string
  stickyFirstColumn?: boolean
  empty?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('overflow-x-auto rounded-card bg-surface shadow-xs', className)}>
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-[1] bg-sunken">
          <tr>
            {columns.map((c, i) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  't-footnote h-9 whitespace-nowrap px-3 font-medium text-foreground-secondary',
                  c.align === 'right' && 'text-right',
                  stickyFirstColumn && i === 0 && 'sticky left-0 z-[2] bg-sunken',
                  c.className,
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && empty ? (
            <tr><td colSpan={columns.length} className="px-3 py-8 text-center text-sm text-foreground-secondary">{empty}</td></tr>
          ) : (
            rows.map((r) => (
              <tr key={rowKey(r)} className="hairline-t">
                {columns.map((c, i) => {
                  const Cell = i === 0 ? 'th' : 'td'
                  return (
                    <Cell
                      key={c.key}
                      {...(i === 0 ? { scope: 'row' as const } : {})}
                      style={{ height: 'var(--row-h-data)' }}
                      className={cn(
                        'whitespace-nowrap px-3 text-[14px] font-normal text-foreground',
                        c.align === 'right' && 'text-right tabular-nums text-numeric',
                        stickyFirstColumn && i === 0 && 'sticky left-0 bg-surface',
                        c.className,
                      )}
                    >
                      {c.render(r)}
                    </Cell>
                  )
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
