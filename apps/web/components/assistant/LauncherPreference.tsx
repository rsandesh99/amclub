'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useAnalytics } from '@/components/providers/posthog'
import { LAUNCHER_PREF_EVENT, readLauncherHidden, writeLauncherHidden } from './AssistantLauncher'

/** The assistant home's switch for the corner button (per device; the button reads the same key). */
export function LauncherPreference({ persona }: { persona: 'buyer' | 'provider' }) {
  const t = useTranslations('assistant_home')
  const analytics = useAnalytics()
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    const sync = () => setHidden(readLauncherHidden())
    sync()
    window.addEventListener(LAUNCHER_PREF_EVENT, sync)
    return () => window.removeEventListener(LAUNCHER_PREF_EVENT, sync)
  }, [])

  return (
    <section className="rounded-card border border-border bg-surface p-5 shadow-card" aria-labelledby="launcher-pref">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="launcher-pref" className="t-headline text-foreground">{t('launcher_pref_title')}</h2>
          <p className="t-subhead mt-1 text-foreground-secondary">{t('launcher_pref_body')}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={!hidden}
          aria-labelledby="launcher-pref"
          onClick={() => { writeLauncherHidden(!hidden); analytics.capture('assistant_launcher_pref_changed', { persona, shown: hidden }) }}
          className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors ${hidden ? 'bg-foreground/20' : 'bg-primary'}`}
          data-testid="launcher-pref"
        >
          <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${hidden ? 'translate-x-1' : 'translate-x-6'}`} />
        </button>
      </div>
    </section>
  )
}
