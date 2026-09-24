import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * v3 StickyActionBar (PRD §3.6): the one primary action pinned to the bottom
 * on phones, on material, safe-area aware. Hidden from `hideFrom` up, where the
 * page shows the action inline. Pair with bottom padding on the page.
 */
export function StickyActionBar({ children, hideFrom = 'lg', className }: { children: ReactNode; hideFrom?: 'md' | 'lg' | 'never'; className?: string }) {
  return (
    <div
      data-bottom-bar
      className={cn(
        'material hairline-t fixed inset-x-0 bottom-0 z-30 px-4 pt-3',
        hideFrom === 'md' && 'md:hidden',
        hideFrom === 'lg' && 'lg:hidden',
        className,
      )}
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">{children}</div>
    </div>
  )
}
