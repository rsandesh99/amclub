import { useTranslations } from 'next-intl'
import { Compass } from 'lucide-react'
import { Link } from '@/i18n/navigation'

export default function NotFound() {
  const t = useTranslations('not_found')

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
        <Compass className="h-8 w-8 text-primary" />
      </span>
      <p className="font-display text-5xl font-bold text-primary">404</p>
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="max-w-sm text-sm text-foreground-secondary">{t('subtitle')}</p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <Link href="/" className="rounded-button bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary/90">
          {t('home')}
        </Link>
        <Link href="/services" className="rounded-button border border-border px-5 py-2.5 text-sm font-medium text-primary hover:bg-primary/5">
          {t('browse')}
        </Link>
      </div>
    </main>
  )
}
