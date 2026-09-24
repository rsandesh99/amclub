import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { getKycReviewItems } from '@/lib/kyc/review'

const REASONS = ['mismatch', 'no_reference', 'no_vendor_name', 'id_conflict'] as const

/**
 * Audit M12 / ADR 028 — KYC attempts waiting for ops on the verification
 * queue: a Udyam or penny-drop record that is not the account's own business,
 * and Udyam numbers another account already holds. Read-only; ops act from the
 * provider page (bank override) or by releasing a claim (runbook in ADR 028).
 */
export async function KycOwnershipFlags() {
  const items = await getKycReviewItems(await createAdminClient())
  if (items.length === 0) return null
  const t = await getTranslations('trust_admin')
  return (
    <section className="rounded-card border border-warning/40 bg-warning/5 p-4" data-testid="kyc-ownership-flags">
      <h2 className="text-sm font-semibold text-warning">{t('kyc_flags', { count: items.length })}</h2>
      <p className="mt-1 text-xs text-foreground-secondary">{t('kyc_flags_body')}</p>
      <ul className="mt-2 space-y-2 text-sm">
        {items.map((f) => {
          const reason = (REASONS as readonly string[]).includes(f.reason ?? '') ? (f.reason as (typeof REASONS)[number]) : null
          return (
            <li key={`${f.kind}-${f.id}`} data-kyc-flag={f.id} className="rounded-button bg-surface px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                {f.providerId ? (
                  <Link href={`/admin/providers/${f.providerId}` as '/admin/providers'} className="font-medium text-primary hover:underline">{f.accountName ?? f.providerId}</Link>
                ) : (
                  <span className="font-medium">{f.accountName ? t('kyc_flag_buyer', { name: f.accountName }) : t('kyc_flag_no_profile')}</span>
                )}
                <span className="text-xs text-foreground-secondary">
                  {f.kind === 'udyam' ? t('kyc_flag_udyam', { number: f.subject }) : t('kyc_flag_bank', { ifsc: f.subject })}
                </span>
                <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs text-warning">
                  {f.outcome === 'udyam_already_claimed' ? t('kyc_flag_claimed') : reason ? t(`kyc_reason_${reason}` as 'kyc_reason_mismatch') : t('kyc_reason_mismatch')}
                </span>
              </div>
              {f.outcome === 'name_mismatch' && (
                <p className="mt-1 text-xs text-foreground-secondary">
                  {t('kyc_flag_names', { vendor: f.vendorName ?? '—', reference: f.reference ?? '—' })}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
