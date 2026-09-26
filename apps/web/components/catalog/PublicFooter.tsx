import { Link } from '@/i18n/navigation'
import { getCategories } from '@/lib/catalog/queries'
import { pickI18n } from '@/lib/format'
import { getLocale, getTranslations } from 'next-intl/server'
import { FooterSignIn } from './FooterSignIn'

export async function PublicFooter() {
  const t = await getTranslations()
  const locale = await getLocale()
  const categories = await getCategories()

  return (
    <footer className="mt-16 border-t border-border bg-surface">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-4 py-10 sm:grid-cols-4">
        <div className="col-span-2 sm:col-span-1">
          <span className="font-display text-lg font-bold text-primary">AMClub</span>
          <p className="mt-2 max-w-xs text-sm text-foreground-secondary">{t('common.tagline')}</p>
        </div>
        <div>
          <h4 className="text-sm font-semibold">{t('catalog.categories')}</h4>
          <ul className="mt-3 space-y-2 text-sm text-foreground-secondary">
            {categories.slice(0, 6).map((c) => (
              <li key={c.slug}>
                <Link href={`/services/${c.slug}`} className="hover:text-primary">
                  {pickI18n(c.nameI18n, locale)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="text-sm font-semibold">{t('catalog.for_providers')}</h4>
          <ul className="mt-3 space-y-2 text-sm text-foreground-secondary">
            <li>
              <Link href="/partner/signup" className="hover:text-primary">
                {t('catalog.become_provider')}
              </Link>
            </li>
            <li>
              <Link href="/provider-addendum" className="hover:text-primary">
                {t('legal.provider_addendum_title')}
              </Link>
            </li>
            {/* Hidden for a signed-in visitor (the page is static; the client knows). */}
            <FooterSignIn />
          </ul>
        </div>
        <div>
          <h4 className="text-sm font-semibold">{t('catalog.company')}</h4>
          <ul className="mt-3 space-y-2 text-sm text-foreground-secondary">
            <li>
              <Link href="/services" className="hover:text-primary">
                {t('catalog.browse_services')}
              </Link>
            </li>
            <li>
              <Link href="/help" className="hover:text-primary">
                {t('legal.help_link')}
              </Link>
            </li>
            <li>
              <Link href="/terms" className="hover:text-primary">
                {t('legal.terms_title')}
              </Link>
            </li>
            <li>
              <Link href="/privacy" className="hover:text-primary">
                {t('legal.privacy_title')}
              </Link>
            </li>
            <li>
              <Link href="/refund-policy" className="hover:text-primary">
                {t('legal.refund_title')}
              </Link>
            </li>
            <li>
              <Link href="/grievance" className="hover:text-primary">
                {t('legal.grievance_link')}
              </Link>
            </li>
            <li>
              <Link href="/help/whatsapp-safety" className="hover:text-primary">
                {t('help.footer_safety')}
              </Link>
            </li>
          </ul>
        </div>
      </div>
      <div className="border-t border-border py-4 text-center text-xs text-foreground-secondary">
        © {new Date().getFullYear()} AMClub · {t('common.tagline')}
      </div>
    </footer>
  )
}
