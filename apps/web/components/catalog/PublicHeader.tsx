import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { LanguageSwitcher } from './LanguageSwitcher'
import { JurisdictionSelector } from './JurisdictionSelector'
import { PublicHeaderAccount } from './PublicHeaderAccount'

/** Shared header for public marketing/catalog pages. Stays a static server
 *  component; the account area (sign-in vs avatar) is a client child. */
export function PublicHeader() {
  const t = useTranslations('catalog')

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="font-display text-lg font-bold text-primary">
            AMClub
          </Link>
          <nav className="hidden items-center gap-1 text-sm font-medium text-foreground-secondary sm:flex">
            <Link href="/services" className="inline-flex items-center rounded-button px-3 py-2 leading-none transition-colors hover:bg-primary/5 hover:text-primary">
              {t('browse_services')}
            </Link>
            {/* /partner/onboarding works for both: logged-in → KYC; logged-out → login → KYC. */}
            <Link href="/partner/onboarding" className="inline-flex items-center rounded-button px-3 py-2 leading-none transition-colors hover:bg-primary/5 hover:text-primary">
              {t('become_provider')}
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <JurisdictionSelector className="hidden sm:inline-flex" />
          <LanguageSwitcher />
          <PublicHeaderAccount />
        </div>
      </div>
    </header>
  )
}
