import { getTranslations } from 'next-intl/server'
import { SPECIALIZATIONS, type CategorySlug } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { cn } from '@/lib/utils'

/**
 * FR-2.3 sibling chips from the level-2 taxonomy: every service of the
 * category, linking to its landing page (/services/[category]/[service]).
 */
export async function ServiceChips({ category, current }: { category: string; current?: string | undefined }) {
  const services = SPECIALIZATIONS[category as CategorySlug]
  if (!services) return null
  const t = await getTranslations('services')
  const tf = await getTranslations('filters_v3')
  return (
    <nav aria-label={tf('sec_service')} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" data-testid="service-chips">
      {services.map((sv) => (
        <Link
          key={sv}
          href={`/services/${category}/${sv}` as '/services'}
          aria-current={sv === current ? 'page' : undefined}
          className={cn(
            'inline-flex min-h-[32px] shrink-0 items-center rounded-chip px-3 text-sm',
            sv === current ? 'bg-foreground font-medium text-background' : 'bg-sunken text-foreground-secondary hover:text-foreground',
          )}
        >
          {t(sv as 'gst-filing')}
        </Link>
      ))}
    </nav>
  )
}
