'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useAnalytics } from '@/components/providers/posthog'

/**
 * E15 FR-15.4 (F6) — the corpus opt-in. Off by default; turning it off deletes
 * everything collected under it. Text only: no audio is ever kept.
 */
export function CorpusConsentSection({ initialOn }: { initialOn: boolean }) {
  const t = useTranslations('profile')
  const analytics = useAnalytics()
  const [on, setOn] = useState(initialOn)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function toggle(next: boolean) {
    setBusy(true); setNote(null)
    const res = await fetch('/api/v1/me/corpus-consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: next }) })
    setBusy(false)
    if (!res.ok) { setNote(t('corpus_error')); return }
    setOn(next)
    analytics.capture('corpus_consent_changed', { on: next, device: 'web' })
    setNote(next ? t('corpus_on_note') : t('corpus_off_note'))
  }

  return (
    <section className="rounded-card border border-border bg-surface p-4" data-testid="corpus-consent">
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={on} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
        <span>
          <span className="block text-sm font-semibold">{t('corpus_title')}</span>
          <span className="mt-1 block text-xs text-foreground-secondary">{t('corpus_body')}</span>
        </span>
      </label>
      {note && <p className="mt-2 text-xs text-foreground-secondary" role="status">{note}</p>}
    </section>
  )
}
