import { getTranslations } from 'next-intl/server'
import { createAdminClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { VerificationActions } from './VerificationActions'

interface ProviderRow {
  id: string
  legal_name: string
  display_name: string
  gstin: string | null
  pan: string | null
  state: string
  status: string
  created_at: string
  user: { phone: string | null; email: string | null } | null
  categories: { category: { name_i18n: { en: string } } }[]
  verifications: { kind: string; document_url: string | null; status: string }[]
  bank: { account_holder: string; ifsc: string; penny_drop_verified: boolean } | null
}

async function getPendingProviders() {
  const supabase = await createAdminClient()
  const { data, error } = await supabase
    .from('provider_profiles')
    .select(`
      id, legal_name, display_name, gstin, pan, state, status, created_at,
      user:users(phone, email),
      categories:provider_categories(category:categories(name_i18n)),
      verifications:provider_verifications(kind, document_url, status),
      bank:provider_bank_accounts(account_holder, ifsc, penny_drop_verified)
    `)
    .in('status', ['pending_kyc', 'under_review'])
    .order('created_at', { ascending: true })

  if (error) throw error
  return (data ?? []) as unknown as ProviderRow[]
}

export default async function VerificationsPage() {
  const t = await getTranslations('admin')
  const providers = await getPendingProviders()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('verifications_title')}</h1>
        <p className="text-sm text-foreground-secondary mt-1">{t('verifications_subtitle')}</p>
      </div>

      {providers.length === 0 ? (
        <div className="rounded-card border border-gray-200 bg-surface p-12 text-center shadow-card">
          <p className="text-foreground-secondary">{t('no_pending')}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {providers.map((p) => (
            <div key={p.id} className="rounded-card border border-gray-200 bg-surface shadow-card">
              <div className="p-5">
                {/* Header */}
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-lg">{p.legal_name}</h2>
                    <p className="text-sm text-foreground-secondary">{p.display_name}</p>
                    <p className="text-xs text-foreground-secondary mt-1">
                      {p.user?.phone ?? p.user?.email ?? '—'} · {p.state}
                    </p>
                  </div>
                  <Badge variant={p.status === 'under_review' ? 'info' : 'warning'}>
                    {p.status === 'under_review' ? t('pending_badge') : 'Pending KYC'}
                  </Badge>
                </div>

                {/* Details grid */}
                <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <div>
                    <dt className="text-xs font-medium text-foreground-secondary uppercase tracking-wide">{t('gstin')}</dt>
                    <dd className="mt-0.5 font-mono">{p.gstin ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-foreground-secondary uppercase tracking-wide">{t('pan')}</dt>
                    <dd className="mt-0.5 font-mono">{p.pan ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-foreground-secondary uppercase tracking-wide">{t('categories')}</dt>
                    <dd className="mt-0.5">
                      {p.categories.length > 0
                        ? p.categories.map((c) => c.category.name_i18n.en).join(', ')
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-foreground-secondary uppercase tracking-wide">{t('bank_account')}</dt>
                    <dd className="mt-0.5">
                      {p.bank
                        ? `${p.bank.account_holder} · ${p.bank.ifsc} · ${p.bank.penny_drop_verified ? t('bank_verified') : t('bank_unverified')}`
                        : '—'}
                    </dd>
                  </div>
                </dl>

                {/* Credentials */}
                {p.verifications.length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs font-medium text-foreground-secondary uppercase tracking-wide mb-2">{t('credentials')}</p>
                    <div className="flex flex-wrap gap-2">
                      {p.verifications.map((v) => (
                        <div key={v.kind} className="flex items-center gap-2 rounded-[8px] border border-gray-200 px-3 py-1.5 text-xs">
                          <span className="font-medium">{v.kind.replace(/_/g, ' ')}</span>
                          {v.document_url && (
                            <a
                              href={v.document_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-trust underline underline-offset-1"
                            >
                              {t('view_credential')}
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Approve / Reject actions */}
                <VerificationActions providerId={p.id} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
