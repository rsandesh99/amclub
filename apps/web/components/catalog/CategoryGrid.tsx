import { useLocale } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { pickI18n } from '@/lib/format'
import { CategoryIcon } from './CategoryIcon'
import type { CategoryRow } from '@/lib/catalog/types'

export function CategoryGrid({
  categories,
  compact = false,
}: {
  categories: CategoryRow[]
  compact?: boolean
}) {
  const locale = useLocale()

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {categories.map((c) => (
        <Link
          key={c.slug}
          href={`/services/${c.slug}`}
          className="card-interactive group flex h-full flex-col gap-2 p-4 hover:bg-primary/[0.03]"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-button bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-white">
            <CategoryIcon icon={c.icon} className="h-5 w-5" />
          </div>
          <span className="text-sm font-semibold leading-snug text-foreground group-hover:text-primary">
            {pickI18n(c.nameI18n, locale)}
          </span>
          {!compact && c.descriptionI18n && (
            <span className="line-clamp-2 text-xs text-foreground-secondary">
              {pickI18n(c.descriptionI18n, locale)}
            </span>
          )}
        </Link>
      ))}
    </div>
  )
}
