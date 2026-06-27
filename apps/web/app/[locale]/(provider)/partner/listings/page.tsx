import { redirect } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { Plus, PackageOpen } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { Badge } from '@/components/ui/badge'
import { PriceBlock } from '@/components/catalog/PriceBlock'
import { ListingActions } from '@/components/partner/ListingActions'
import { pickI18n } from '@/lib/format'

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'default' | 'danger'> = {
  active: 'success',
  paused: 'warning',
  draft: 'default',
  removed: 'danger',
}

export default async function ListingsPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/listings')

  const t = await getTranslations('listings')
  const locale = await getLocale()
  const supabase = await createClient()

  const { data: provider } = await supabase
    .from('provider_profiles')
    .select('id, status')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!provider) redirect('/partner/onboarding')

  const { data: packages } = await supabase
    .from('packages')
    .select('id, slug, title_i18n, price_paise, discount_bps, member_extra_discount_bps, status, category:categories(slug, name_i18n)')
    .eq('provider_id', provider.id)
    .neq('status', 'removed')
    .order('created_at', { ascending: false })

  const list = packages ?? []

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
          <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
        </div>
        <Link
          href="/partner/listings/new"
          className="inline-flex items-center gap-2 rounded-button bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> {t('new_listing')}
        </Link>
      </div>

      {provider.status !== 'active' && (
        <div className="mb-6 rounded-card border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
          {t('not_active_notice')}
        </div>
      )}

      {list.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border bg-surface px-6 py-16 text-center">
          <PackageOpen className="h-10 w-10 text-foreground-secondary" />
          <h3 className="text-md font-semibold">{t('empty_title')}</h3>
          <p className="max-w-sm text-sm text-foreground-secondary">{t('empty_body')}</p>
          <Link
            href="/partner/listings/new"
            className="mt-2 inline-flex items-center gap-2 rounded-button bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> {t('create_first')}
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {list.map((pk) => {
            /* eslint-disable @typescript-eslint/no-explicit-any */
            const cat = pk.category as any
            /* eslint-enable @typescript-eslint/no-explicit-any */
            return (
              <li
                key={pk.id}
                className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate font-medium">{pickI18n(pk.title_i18n as { en: string; hi?: string }, locale)}</h2>
                    <Badge variant={STATUS_VARIANT[pk.status] ?? 'default'}>{t(`status_${pk.status}` as 'status_active')}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-foreground-secondary">
                    {cat?.name_i18n ? pickI18n(cat.name_i18n, locale) : ''}
                  </p>
                  <div className="mt-2">
                    <PriceBlock
                      pricePaise={Number(pk.price_paise)}
                      discountBps={pk.discount_bps}
                      memberExtraDiscountBps={pk.member_extra_discount_bps}
                    />
                  </div>
                </div>
                <ListingActions packageId={pk.id} status={pk.status} />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
