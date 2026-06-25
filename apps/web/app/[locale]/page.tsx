import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { ORDER_STATUSES, CATEGORY_LIST } from '@amclub/shared'

export default function HelloWorldPage() {
  const t = useTranslations('hello')
  const tLocale = useTranslations('locale')

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-8 bg-background">
      {/* AMClub brand */}
      <div className="text-center">
        <h1 className="text-2xl font-bold text-primary">{t('title')}</h1>
        <p className="mt-2 text-sm text-foreground-secondary max-w-md">{t('subtitle')}</p>
      </div>

      {/* Locale switcher — proves next-intl routing works */}
      <div className="flex items-center gap-2 rounded-chip border border-gray-200 bg-surface px-4 py-2 shadow-card">
        <span className="text-xs text-foreground-secondary mr-2">{tLocale('switch')}:</span>
        <Link
          href="/"
          locale="en"
          className="rounded px-3 py-1 text-sm font-medium text-primary hover:bg-primary/10 transition-colors"
        >
          {tLocale('en')}
        </Link>
        <span className="text-gray-300">|</span>
        <Link
          href="/"
          locale="hi"
          className="rounded px-3 py-1 text-sm font-medium text-primary hover:bg-primary/10 transition-colors"
        >
          {tLocale('hi')}
        </Link>
      </div>

      {/* Proves @amclub/shared import works */}
      <div className="w-full max-w-lg rounded-card border border-gray-200 bg-surface p-6 shadow-card">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-foreground-secondary">
          {t('shared_proof')}
        </p>
        <div className="flex flex-wrap gap-2">
          {ORDER_STATUSES.map((status) => (
            <span
              key={status}
              className="rounded-chip bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
            >
              {status}
            </span>
          ))}
        </div>
      </div>

      {/* Proves category constants work */}
      <div className="w-full max-w-lg rounded-card border border-gray-200 bg-surface p-6 shadow-card">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-foreground-secondary">
          {CATEGORY_LIST.length} categories (from @amclub/shared):
        </p>
        <div className="flex flex-wrap gap-2">
          {CATEGORY_LIST.map((cat) => (
            <span
              key={cat.slug}
              className="rounded-chip border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-medium text-foreground"
            >
              {cat.name_i18n.en}
            </span>
          ))}
        </div>
      </div>

      <p className="text-xs text-foreground-secondary">{t('web_note')}</p>
    </main>
  )
}
