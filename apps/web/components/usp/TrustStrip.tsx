import { getTranslations } from 'next-intl/server'
import { BadgeCheck, Lock, PhoneOff, Receipt } from 'lucide-react'

const ITEMS = [
  { key: 'no_spam', Icon: PhoneOff },
  { key: 'escrow', Icon: Lock },
  { key: 'verified', Icon: BadgeCheck },
  { key: 'gst_invoice', Icon: Receipt },
] as const

/**
 * E18 (flag `guide`): four buyer promises as one line of chips under the
 * search bar, so the reasons to buy here are visible before the first click.
 * The same copy as "Why AMClub" (`why_amclub.buyers.*.title`).
 */
export async function TrustStrip({ className }: { className?: string }) {
  const t = await getTranslations('why_amclub')
  return (
    <ul className={`flex flex-wrap gap-x-4 gap-y-1.5 ${className ?? ''}`} aria-label={t('strip_label')} data-testid="trust-strip">
      {ITEMS.map(({ key, Icon }) => (
        <li key={key} className="inline-flex items-center gap-1.5 text-[13px] text-foreground-secondary">
          <Icon className="h-4 w-4 text-primary" strokeWidth={1.75} aria-hidden />
          {t(`buyers.${key}.title`)}
        </li>
      ))}
    </ul>
  )
}
