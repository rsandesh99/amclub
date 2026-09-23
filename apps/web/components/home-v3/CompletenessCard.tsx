'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { X } from 'lucide-react'
import { dismissUntil, isDismissed } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { Progress } from '@/components/ui/progress'

const KEY = 'amc_home_completeness_dismissed_until'

/** E9 FR-9.4 — the profile-completeness card (under 80 %); dismissing hides it for 7 days on this device. */
export function CompletenessCard({ completeness }: { completeness: number }) {
  const t = useTranslations('home_v3')
  const tProfile = useTranslations('profile')
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    try { if (isDismissed(localStorage.getItem(KEY), Date.now())) setHidden(true) } catch { /* private mode: keep showing */ }
  }, [])
  if (hidden) return null
  return (
    <div className="relative rounded-card border border-warning/30 bg-warning/10 p-4" data-testid="home-completeness">
      <button
        type="button"
        onClick={() => { try { localStorage.setItem(KEY, String(dismissUntil(Date.now()))) } catch { /* ignore */ } setHidden(true) }}
        className="absolute right-2 top-2 rounded-full p-1 text-foreground-secondary hover:bg-foreground/5"
        aria-label={t('dismiss')}
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
      <p className="mb-2 pr-6 text-sm font-medium text-warning">{t('complete_profile')}</p>
      <Progress value={completeness} label={tProfile('completeness')} />
      <Link href="/app/profile" className="mt-3 inline-block text-xs text-primary underline underline-offset-2">{tProfile('edit_profile')} →</Link>
    </div>
  )
}
