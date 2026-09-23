import { getLocale, getTranslations } from 'next-intl/server'
import { pickLocale, type AttributeFacet } from '@amclub/shared'
import { Link } from '@/i18n/navigation'

function withParams(base: string, current: Record<string, string | undefined>, patch: Record<string, string | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) p.set(k, v)
  const qs = p.toString()
  return qs ? `${base}?${qs}` : base
}

/**
 * E16 N40 — typed-attribute facets for one category (facetable enum / bool
 * definitions only; counts over the category's active listings). Server
 * rendered links like the rest of FilterBar: `a.<key>=<value>`, no JS.
 */
export async function AttributeFacets({ base, current, facets }: { base: string; current: Record<string, string | undefined>; facets: AttributeFacet[] }) {
  if (facets.length === 0) return null
  const [t, locale] = await Promise.all([getTranslations('mart'), getLocale()])
  const chip = (active: boolean) => `chip-toggle h-10 shrink-0 text-meta ${active ? 'border-emerald bg-emerald text-ivory' : 'border-brass/50 bg-ivory text-emerald-ink'}`
  const shown = (v: string) => (v === 'true' ? t('attr_yes') : v === 'false' ? t('attr_no') : v)
  return (
    <div className="mt-2 space-y-2" data-testid="attribute-facets">
      {facets.map((f) => {
        const param = `a.${f.key}`
        const label = pickLocale(f.label_i18n, locale)
        return (
          <div key={f.key} className="-mx-4 flex items-center gap-2 overflow-x-auto px-4" role="group" aria-label={label}>
            <span className="shrink-0 text-meta font-medium text-foreground-secondary">{label}</span>
            <Link href={withParams(base, current, { [param]: undefined }) as '/services'} className={chip(!current[param])} aria-pressed={!current[param]}>{t('attr_any')}</Link>
            {f.values.map((v) => (
              <Link key={v.value} href={withParams(base, current, { [param]: v.value }) as '/services'} className={chip(current[param] === v.value)} aria-pressed={current[param] === v.value}>
                {shown(v.value)} <span className="tabular-nums opacity-70">({v.count})</span>
              </Link>
            ))}
          </div>
        )
      })}
    </div>
  )
}
