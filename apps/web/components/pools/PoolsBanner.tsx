import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { AGENT_ENABLED } from '@/lib/flags'
import { poolsOnFor } from '@/lib/pools/core'
import { providerPools } from '@/lib/pools/queries'

/**
 * S3.4 (ADR 024, dark) — one line above the provider's request inbox when group requests are open for them. Renders
 * nothing (and reads no pool table) unless AGENT_ENABLED + demand_aggregation + this provider in the cohort.
 */
export async function PoolsBanner({ userId, providerId }: { userId: string; providerId: string }) {
  if (!AGENT_ENABLED) return null
  const admin = await createAdminClient()
  if (!(await poolsOnFor(admin, userId))) return null
  const open = (await providerPools(admin, providerId)).filter((p) => p.status === 'open' && !p.hasMyOffer)
  if (open.length === 0) return null
  const t = await getTranslations('pools')
  return (
    <div className="mx-auto max-w-5xl px-4 pt-6">
      <Link href="/partner/pools" className="flex items-center justify-between gap-3 rounded-card border border-primary/30 bg-primary/5 px-4 py-3 text-sm font-medium" data-testid="pools-banner">
        <span>{t('partner_banner', { n: open.length })}</span>
        <span className="text-primary">{t('open_group')} →</span>
      </Link>
    </div>
  )
}
