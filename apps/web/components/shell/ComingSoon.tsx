import { getTranslations } from 'next-intl/server'
import { Clock } from 'lucide-react'
import { Link } from '@/i18n/navigation'

interface ComingSoonProps {
  title: string
  body: string
  /** Where the primary CTA goes. */
  homeHref: '/app' | '/partner'
  /** Show the "browse services" secondary CTA (buyer context only). */
  showBrowse?: boolean
}

/** Friendly placeholder for routes whose feature ships in a later phase.
 *  Keeps navigation honest — linked routes resolve instead of 404-ing. */
export async function ComingSoon({ title, body, homeHref, showBrowse }: ComingSoonProps) {
  const t = await getTranslations('coming_soon')

  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-20 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
        <Clock className="h-7 w-7 text-primary" />
      </span>
      <span className="mt-4 inline-block rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-amber-700">
        {t('badge')}
      </span>
      <h1 className="mt-3 text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-foreground-secondary">{body}</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link
          href={homeHref}
          className="rounded-button bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary/90"
        >
          {t('back_home')}
        </Link>
        {showBrowse && (
          <Link
            href="/services"
            className="rounded-button border border-gray-200 px-4 py-2.5 text-sm font-medium text-primary hover:bg-primary/5"
          >
            {t('browse_services')}
          </Link>
        )}
      </div>
    </div>
  )
}
