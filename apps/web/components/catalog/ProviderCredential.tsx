import { useTranslations } from 'next-intl'
import { BadgeCheck, ShieldCheck } from 'lucide-react'

/**
 * Credential-first provider identity block (§4.3): leads with name + headline
 * professional credential + verification. Rating is rendered separately and
 * secondary by the caller. Shared by ResultCard, ProviderMiniCard and the
 * provider detail header so the trust framing is identical everywhere.
 */
export function ProviderCredential({
  name,
  credentialKind,
  verified,
  nameClassName = 'text-sm font-semibold text-foreground',
}: {
  name: string
  /** Professional credential kind (e.g. 'icai'), or null. Never the number. */
  credentialKind: string | null
  verified: boolean
  nameClassName?: string
}) {
  const t = useTranslations('catalog')

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1">
        <span className={`truncate ${nameClassName}`}>{name}</span>
        {verified && <BadgeCheck className="h-4 w-4 shrink-0 text-verified" aria-label={t('verified')} />}
      </div>
      {credentialKind ? (
        <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-verified">
          <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden />
          {t(`badge_${credentialKind}` as 'badge_gstin')} · {t('verified')}
        </span>
      ) : verified ? (
        <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-verified">
          <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden /> {t('verified')}
        </span>
      ) : null}
    </div>
  )
}
