'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useAnalytics } from '@/components/providers/posthog'

/**
 * E14 FR-14.3 — a provider's copy that is an APPROVED machine translation:
 * the text, a quiet "Translated · View original" line, and the English on a
 * tap (and back). Only a slot whose source is `machine_approved` uses this —
 * a draft never reaches a buyer page.
 */
export function TranslatedText({ text, original, lang, as: Tag = 'span', className }: { text: string; original: string; lang: string; as?: 'span' | 'p' | 'h1'; className?: string }) {
  const t = useTranslations('catalog')
  const analytics = useAnalytics()
  const [showOriginal, setShowOriginal] = useState(false)
  return (
    <>
      <Tag className={className} lang={showOriginal ? 'en' : lang} data-translated={showOriginal ? 'original' : 'translation'}>{showOriginal ? original : text}</Tag>
      <span className="mt-1 block text-xs text-foreground-secondary">
        {t('translated')} ·{' '}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => {
            if (!showOriginal) analytics.capture('translation_viewed_original', { device: 'web' })
            setShowOriginal((v) => !v)
          }}
        >
          {showOriginal ? t('view_translation') : t('view_original')}
        </button>
      </span>
    </>
  )
}
