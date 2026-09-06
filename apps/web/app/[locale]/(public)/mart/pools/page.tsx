import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { martPageGate } from '@/lib/mart/gate'
import { createAdminClient } from '@/lib/supabase/server'
import { listPublicPools, poolProgressFor } from '@/lib/mart/pools'
import { JaaliHeader } from '@/components/mart/primitives'
import { PoolCard } from '@/components/mart/PoolCard'
import { MART_ENABLED } from '@/lib/flags'

/** Group buys — ISR 60s (the join island shows live numbers). */
export const revalidate = 60

export async function generateMetadata(): Promise<Metadata> {
  if (!MART_ENABLED) return {}
  const t = await getTranslations('mart')
  return { title: t('pools_title'), description: t('pools_subtitle'), alternates: { canonical: '/mart/pools' } }
}

export default async function MartPoolsPage() {
  martPageGate()
  const [t, admin] = await Promise.all([getTranslations('mart'), createAdminClient()])
  const pools = await listPublicPools(admin)
  return (
    <div className="mart-enter">
      <JaaliHeader>
        <nav className="text-meta text-foreground-secondary" aria-label="Breadcrumb">
          <Link href={'/mart' as '/services'} className="inline-flex min-h-11 items-center hover:underline">{t('title')}</Link>
        </nav>
        <h1 className="font-display text-3xl font-bold tracking-tight text-emerald-ink">{t('pools_title')}</h1>
        <p className="mt-1 max-w-2xl text-body text-emerald-ink/80">{t('pools_subtitle')}</p>
      </JaaliHeader>
      <div className="mx-auto max-w-6xl px-4 py-6">
        {pools.length === 0 ? (
          <div className="jaali-ivory rounded-[10px] border border-brass/40 px-6 py-16 text-center">
            <h2 className="text-lg font-semibold text-emerald-ink">{t('pools_empty_title')}</h2>
            <p className="mx-auto mt-1 max-w-md text-body text-foreground-secondary">{t('pools_empty_body')}</p>
            <Link href={'/mart' as '/services'} className="mt-4 inline-flex min-h-11 items-center rounded-button bg-emerald px-4 text-meta font-semibold text-ivory">{t('title')}</Link>
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {pools.map((p, i) => (
              <li key={p.id}><PoolCard pool={p} progress={poolProgressFor(p)} priority={i < 3} /></li>
            ))}
          </ul>
        )}
        <section className="mt-8 grid gap-3 sm:grid-cols-3">
          {(['pool_how_1', 'pool_how_2', 'pool_how_3'] as const).map((k, i) => (
            <div key={k} className="sheet-card p-4">
              <span className="gold-numeral text-2xl">{i + 1}</span>
              <p className="mt-1 text-body text-emerald-ink">{t(k)}</p>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}
