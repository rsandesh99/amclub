'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'

export interface PendingLogo {
  providerId: string
  displayName: string
  signedUrl: string | null
}

/** E3 / N12 — the admin's logo moderation list (approve publishes; reject clears). */
export function PendingLogos({ items }: { items: PendingLogo[] }) {
  const t = useTranslations('trust_admin')
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  async function decide(id: string, decision: 'approve' | 'reject') {
    setBusy(id)
    await fetch(`/api/v1/admin/providers/${id}/logo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) })
    setBusy(null)
    router.refresh()
  }
  if (items.length === 0) return null
  return (
    <section className="rounded-card border border-border bg-surface p-4 shadow-card">
      <h2 className="text-sm font-semibold">{t('pending_logos', { count: items.length })}</h2>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {items.map((l) => (
          <li key={l.providerId} className="flex items-center gap-3 rounded-button bg-muted p-2">
            {l.signedUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL for review
              <img src={l.signedUrl} alt="" width={56} height={56} className="h-14 w-14 rounded-card object-cover" />
            ) : <span className="h-14 w-14 rounded-card bg-surface" />}
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{l.displayName}</span>
            <button type="button" disabled={busy === l.providerId} onClick={() => decide(l.providerId, 'approve')} className="h-9 rounded-button bg-primary px-3 text-xs font-semibold text-primary-foreground">{t('approve')}</button>
            <button type="button" disabled={busy === l.providerId} onClick={() => decide(l.providerId, 'reject')} className="h-9 rounded-button border border-border px-3 text-xs font-semibold">{t('reject')}</button>
          </li>
        ))}
      </ul>
    </section>
  )
}
