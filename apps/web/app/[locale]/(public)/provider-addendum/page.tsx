import { getTranslations } from 'next-intl/server'
import { LegalArticle } from '@/components/legal/LegalArticle'
import { PROVIDER_ADDENDUM_SECTIONS_EFFECTIVE } from '@/lib/legal/versions'

export const revalidate = 86400

// DRAFT FOR COUNSEL REVIEW (Phase 2, version 2026-08-28). The five sections
// (escrow, AMC Score, buyer rating, auto-decline, data use) were drafted
// strictly from founder-decided facts — no obligations were invented beyond
// them. Text lives in messages/{en,hi}.json under legal.provider_addendum_*;
// bump LEGAL_VERSIONS.provider_addendum in packages/shared when it changes
// (every provider then re-accepts on next load).
//
// AMC Mart goods schedule (sections 6–8, Launch Gate item 4) renders only when
// MART_ENABLED=true and carries PROVIDER_ADDENDUM_GOODS_VERSION — the flip is
// the bump. DRAFT FOR COUNSEL: §8 liability / warranty pass-through language
// (MART_DESIGN.md §9.5) is a placeholder stating current product behaviour
// only; counsel adds caps and indemnities before the flag flips.

export async function generateMetadata() {
  const t = await getTranslations('legal')
  return { title: t('provider_addendum_title') }
}

export default function ProviderAddendumPage() {
  return <LegalArticle doc="provider_addendum" sections={PROVIDER_ADDENDUM_SECTIONS_EFFECTIVE} />
}
