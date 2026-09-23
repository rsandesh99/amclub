'use client'

import { useTranslations } from 'next-intl'
import { Pencil } from 'lucide-react'

/** FR-2.5 — "You said: …" after a voice search; tap to edit the words. */
export function YouSaidChip({ text }: { text: string }) {
  const t = useTranslations('filters_v3')
  return (
    <button
      type="button"
      onClick={() => {
        const el = document.getElementById('catalog-search-input') as HTMLInputElement | null
        el?.focus()
        el?.select()
      }}
      className="inline-flex max-w-full items-center gap-2 rounded-chip bg-sunken px-3 py-1.5 text-sm"
      data-testid="you-said"
    >
      <span className="truncate">{t('you_said', { text })}</span>
      <Pencil className="h-3.5 w-3.5 shrink-0 text-foreground-secondary" aria-hidden />
    </button>
  )
}
