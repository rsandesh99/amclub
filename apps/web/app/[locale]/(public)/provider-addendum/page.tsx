import { getTranslations } from 'next-intl/server'
import { LegalArticle } from '@/components/legal/LegalArticle'

export const revalidate = 86400

// DRAFT FOR COUNSEL REVIEW (Phase 2, version 2026-08-28). The five sections
// (escrow, AMC Score, buyer rating, auto-decline, data use) were drafted
// strictly from founder-decided facts — no obligations were invented beyond
// them. Text lives in messages/{en,hi}.json under legal.provider_addendum_*;
// bump LEGAL_VERSIONS.provider_addendum in packages/shared when it changes
// (every provider then re-accepts on next load).

export async function generateMetadata() {
  const t = await getTranslations('legal')
  return { title: t('provider_addendum_title') }
}

export default function ProviderAddendumPage() {
  return <LegalArticle doc="provider_addendum" sections={5} />
}
