'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { LEGAL_DOC_PATHS, LEGAL_VERSIONS, type LegalDoc } from '@amclub/shared'
import { Link, useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

/**
 * Re-acceptance gate for EXISTING users (Phase 2b). On every authenticated
 * shell load it asks /api/v1/legal/status; if any required document is not
 * accepted at its current version, a blocking modal shows the documents
 * (linked) and one Accept button that writes terms_acceptances rows. One tap,
 * no scroll-wall. Mounted once in AppShell so every logged-in surface is gated.
 */
export function LegalGate() {
  const t = useTranslations('legal_gate')
  const locale = useLocale()
  const router = useRouter()
  const [required, setRequired] = useState<LegalDoc[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    fetch('/api/v1/legal/status', { cache: 'no-store' })
      .then(async (r) => {
        const d = (await r.json().catch(() => null)) as { required?: LegalDoc[] } | null
        return r.ok ? d : null
      })
      .then((d) => {
        if (active && d?.required?.length) setRequired(d.required)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  if (required.length === 0) return null

  async function accept() {
    setBusy(true)
    setError(false)
    try {
      const res = await fetch('/api/v1/legal/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs: required, surface: 'web', locale }),
      })
      const d = (await res.json().catch(() => null)) as { required?: LegalDoc[] } | null
      if (!res.ok) throw new Error('accept failed')
      setRequired(d?.required ?? [])
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`))

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="legal-gate-title" className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center">
      <div className="w-full max-w-md rounded-card border border-border bg-surface p-6 shadow-hover">
        <h2 id="legal-gate-title" className="font-display text-xl font-bold text-foreground">{t('title')}</h2>
        <p className="mt-2 text-sm leading-relaxed text-foreground-secondary">{t('body')}</p>
        <ul className="mt-4 space-y-2">
          {required.map((doc) => (
            <li key={doc} className="flex items-center justify-between gap-3 rounded-button border border-border px-3 py-2 text-sm">
              <Link href={LEGAL_DOC_PATHS[doc]} target="_blank" rel="noopener" className="font-medium text-primary underline underline-offset-2 hover:no-underline">
                {t(`doc_${doc}`)}
              </Link>
              <span className="text-xs text-foreground-secondary">{t('updated_on', { date: fmt(LEGAL_VERSIONS[doc]) })}</span>
            </li>
          ))}
        </ul>
        {error && <p className="mt-3 text-sm text-danger">{t('error')}</p>}
        <Button onClick={accept} loading={busy} className="mt-5 w-full">
          {busy ? t('accepting') : t('accept')}
        </Button>
        <button
          type="button"
          onClick={async () => {
            await createClient().auth.signOut()
            router.push('/login')
          }}
          className="mt-3 block w-full text-center text-xs text-foreground-secondary underline underline-offset-2 hover:text-primary"
        >
          {t('sign_out')}
        </button>
      </div>
    </div>
  )
}
