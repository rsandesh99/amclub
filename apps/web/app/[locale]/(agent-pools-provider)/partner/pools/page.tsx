import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { providerPools } from '@/lib/pools/queries'
import { istShort, stateLabel } from '@/lib/pools/labels'
import { Badge } from '@/components/ui/badge'

export const dynamic = 'force-dynamic'

/** S3.4 (ADR 024, dark) — group requests this provider may offer one volume price on, and the ones it offered on. */
export default async function PartnerPoolsPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/pools')
  const admin = await createAdminClient()
  const { data: p } = await admin.from('provider_profiles').select('id').eq('user_id', user.id).maybeSingle()
  if (!p) redirect('/partner/onboarding')
  const t = await getTranslations('pools')
  const tSvc = await getTranslations('services')
  const pools = await providerPools(admin, p.id as string)
  return (
    <div className="mx-auto max-w-3xl px-4 py-8" data-testid="partner-pools">
      <h1 className="font-display text-2xl font-bold">{t('partner_title')}</h1>
      <p className="mt-1 text-sm text-foreground-secondary">{t('partner_subtitle')}</p>
      {pools.length === 0 ? (
        <p className="mt-6 rounded-card border border-border bg-surface p-6 text-sm text-foreground-secondary">{t('partner_empty')}</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {pools.map((pool) => (
            <li key={pool.id} className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4">
              <div>
                <p className="font-semibold">{tSvc.has(pool.serviceSlug as 'gst-filing') ? tSvc(pool.serviceSlug as 'gst-filing') : pool.serviceSlug}</p>
                <p className="text-sm text-foreground-secondary">
                  {t('partner_row', { n: pool.joinedCount, state: stateLabel(pool.state) })}
                  {pool.status === 'open' && pool.closesAt ? <> · {t('closes_at', { when: istShort(pool.closesAt) ?? '' })}</> : <> · {t(`status_${pool.status}`)}</>}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {pool.hasMyOffer && <Badge variant="success">{t('partner_offered')}</Badge>}
                <Link href={`/partner/pools/${pool.id}`} className="inline-flex min-h-[36px] items-center rounded-button bg-primary px-3 text-sm font-medium text-primary-foreground">{t('open_group')}</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
