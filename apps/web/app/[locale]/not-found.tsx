import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'

export default function NotFound() {
  const t = useTranslations('common')

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8">
      <h1 className="text-2xl font-bold text-primary">404</h1>
      <p className="text-foreground-secondary">{t('error')}</p>
      <Link href="/" className="rounded-button bg-primary px-6 py-3 text-sm font-medium text-white">
        {t('back')}
      </Link>
    </main>
  )
}
