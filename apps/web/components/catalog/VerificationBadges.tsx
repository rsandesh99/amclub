import { BadgeCheck, ShieldCheck, Landmark } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { VerificationBadge } from '@/lib/catalog/types'

// Trust-blue verification chips (§4 — never decorative). `kind` → label key.
const KIND_LABEL: Record<string, string> = {
  gstin: 'gstin',
  pan: 'pan',
  bank: 'bank',
  icai: 'icai',
  icsi: 'icsi',
  bar_council: 'bar_council',
  ca: 'ca',
  credential: 'credential',
  msme_cert: 'msme_cert',
}

function iconFor(kind: string) {
  if (kind === 'bank') return Landmark
  if (kind === 'gstin' || kind === 'pan') return ShieldCheck
  return BadgeCheck
}

export function VerificationBadges({
  badges,
  className,
}: {
  badges: VerificationBadge[]
  className?: string
}) {
  const t = useTranslations('catalog')
  if (!badges || badges.length === 0) return null

  // De-dupe by kind (a provider may have multiple rows of the same kind).
  const seen = new Set<string>()
  const unique = badges.filter((b) => {
    if (seen.has(b.kind)) return false
    seen.add(b.kind)
    return true
  })

  return (
    <ul className={className ? className : 'flex flex-wrap gap-1.5'}>
      {unique.map((b) => {
        const Icon = iconFor(b.kind)
        const labelKey = KIND_LABEL[b.kind] ?? 'credential'
        return (
          <li
            key={b.kind}
            className="inline-flex items-center gap-1 rounded-chip border border-trust/30 bg-trust/10 px-2 py-0.5 text-xs font-medium text-trust"
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {t(`badge_${labelKey}` as 'badge_gstin')}
          </li>
        )
      })}
    </ul>
  )
}
