import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { LegalArticle } from '@/components/legal/LegalArticle'

export const revalidate = 86400

export async function generateMetadata() {
  const t = await getTranslations('legal')
  return { title: t('privacy_title') }
}

export default async function PrivacyPage() {
  const t = await getTranslations('legal')
  return (
    <LegalArticle doc="privacy" sections={9}>
      {/* §8 names the officer + commitments; the full block lives on /grievance. */}
      <p className="text-sm text-foreground-secondary">
        <Link href="/grievance" className="font-medium text-primary underline underline-offset-2 hover:no-underline">
          {t('grievance_link')} →
        </Link>
      </p>
    </LegalArticle>
  )
}
