import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { LanguageSwitcher } from './LanguageSwitcher'

/** Shared header for public marketing/catalog pages. */
export function PublicHeader() {
  const t = useTranslations('catalog')
  const tAuth = useTranslations('auth')

  return (
    <header className="sticky top-0 z-30 border-b border-gray-200 bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="font-display text-lg font-bold text-primary">
            AMClub
          </Link>
          <nav className="hidden items-center gap-5 text-sm text-foreground-secondary sm:flex">
            <Link href="/services" className="hover:text-primary">
              {t('browse_services')}
            </Link>
            <Link href="/partner/signup" className="hover:text-primary">
              {t('become_provider')}
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <Link
            href="/login"
            className="rounded-button px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/5"
          >
            {tAuth('sign_in')}
          </Link>
          <Link
            href="/signup"
            className="rounded-button bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary/90"
          >
            {tAuth('sign_up')}
          </Link>
        </div>
      </div>
    </header>
  )
}
