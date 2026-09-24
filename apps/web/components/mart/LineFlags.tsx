'use client'

import { useTranslations } from 'next-intl'

/** E16 N43 — "Not returnable" / "ITC may not be available" under a cart or checkout line (server flags; no logic here). */
export function LineFlags({ nonReturnable, itcIneligible }: { nonReturnable: boolean; itcIneligible: boolean }) {
  const t = useTranslations('mart')
  if (!nonReturnable && !itcIneligible) return null
  return (
    <span className="block text-[11px] text-foreground-secondary" data-testid="line-flags">
      {[nonReturnable ? t('not_returnable') : null, itcIneligible ? t('itc_not_available') : null].filter(Boolean).join(' · ')}
    </span>
  )
}
