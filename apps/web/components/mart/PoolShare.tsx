'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

/** WhatsApp share (wa.me prefilled with the card text) + copy. */
export function PoolShare({ text, className }: { text: string; className?: string }) {
  const t = useTranslations('mart')
  const [copied, setCopied] = useState(false)
  const href = `https://wa.me/?text=${encodeURIComponent(text)}`
  return (
    <div className={`flex flex-wrap gap-2 ${className ?? ''}`}>
      <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-button border border-brass/60 px-3 text-meta font-medium text-emerald-ink hover:bg-emerald/10">
        <span aria-hidden="true">🟢</span> {t('pool_share')}
      </a>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
          } catch {
            /* clipboard blocked — the wa.me link still works */
          }
        }}
        className="inline-flex min-h-11 items-center rounded-button px-3 text-meta font-medium text-emerald underline-offset-2 hover:underline"
      >
        {copied ? t('pool_copied') : t('pool_copy')}
      </button>
    </div>
  )
}
