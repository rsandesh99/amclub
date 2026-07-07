import { getTranslations } from 'next-intl/server'
import { LegalArticle } from '@/components/legal/LegalArticle'

export const revalidate = 86400

export async function generateMetadata() {
  const t = await getTranslations('legal')
  return { title: t('privacy_title') }
}

export default function PrivacyPage() {
  return <LegalArticle doc="privacy" sections={9} />
}
