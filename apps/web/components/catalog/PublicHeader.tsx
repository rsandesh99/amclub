import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { LanguageSwitcher } from './LanguageSwitcher'
import { JurisdictionSelector } from './JurisdictionSelector'
import { PublicHeaderAccount } from './PublicHeaderAccount'
import { isOnForEveryone } from '@/lib/experiments'
import { getCategories } from '@/lib/catalog/queries'
import { PublicNav } from '@/components/shell-v3/PublicNav'

/** Nav links read as buttons: outlined, 40px tall, emerald text — the same
 *  shape as "Sign in" so the whole header is one row of obvious controls. */
const NAV_BUTTON =
  'inline-flex h-10 items-center whitespace-nowrap rounded-button border border-primary/30 bg-surface px-4 text-sm font-semibold text-primary transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2'

/** Shared header for public marketing/catalog pages. Stays a static server
 *  component; the account area (sign-in vs avatar) is a client child.
 *  Experience v3 (EXP_V3_SHELL=on): the material header with the Services
 *  menu, universal search and "Post a requirement" (PRD E1 FR-1.3). */
export async function PublicHeader() {
  if (isOnForEveryone('shell')) return <PublicHeaderV3 />
  return <PublicHeaderV2 />
}

async function PublicHeaderV3() {
  const categories = await getCategories()
  return (
    <header className="material hairline-b sticky top-0 z-30">
      <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-2 px-4 lg:px-6">
        <Link href="/" className="mr-2 shrink-0 text-[22px] font-bold leading-none tracking-tight text-primary" aria-label="AMClub">
          AMClub
        </Link>
        <PublicNav categories={categories.map((c) => ({ slug: c.slug, name: c.nameI18n, description: c.descriptionI18n, icon: c.icon }))} />
        <div className="flex h-10 shrink-0 items-center gap-1">
          <LanguageSwitcher />
          <PublicHeaderAccount />
        </div>
      </div>
    </header>
  )
}

function PublicHeaderV2() {
  const t = useTranslations('catalog')

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
      {/* One 64px row; every control is exactly 40px tall and centred on the
          same axis, so nothing floats above or below its neighbours. */}
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
        <div className="flex h-10 items-center gap-5">
          <Link
            href="/"
            className="font-display text-[26px] font-bold leading-none tracking-tight text-primary"
            aria-label="AMClub"
          >
            AMClub
          </Link>
          <nav className="hidden h-10 items-center gap-2 sm:flex" aria-label={t('browse_services')}>
            <Link href="/services" className={NAV_BUTTON}>
              {t('browse_services')}
            </Link>
            {/* /partner/onboarding works for both: logged-in → KYC; logged-out → login → KYC. */}
            <Link href="/partner/onboarding" className={NAV_BUTTON}>
              {t('become_provider')}
            </Link>
          </nav>
        </div>
        <div className="flex h-10 items-center gap-2">
          <JurisdictionSelector className="hidden md:inline-flex" />
          <LanguageSwitcher />
          <PublicHeaderAccount />
        </div>
      </div>
    </header>
  )
}
