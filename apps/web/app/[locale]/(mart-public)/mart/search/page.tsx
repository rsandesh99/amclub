import type { Metadata } from 'next'
import { Suspense } from 'react'
import { getTranslations } from 'next-intl/server'
import { martPageGate } from '@/lib/mart/gate'
import { MART_ENABLED } from '@/lib/flags'
import { MartBrowse, attrParams, type BrowseParams } from '../_browse'
import { CatalogueSkeleton } from '@/components/mart/skeletons'

/** Search — dynamic (per query); the shell streams immediately, results follow. */
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  if (!MART_ENABLED) return {}
  const t = await getTranslations('mart')
  return { title: `${t('search_btn')} · ${t('title')}`, robots: { index: false } }
}

export default async function MartSearchPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  martPageGate()
  const sp = await searchParams
  const p: BrowseParams = { query: sp['query']?.trim(), category: sp['category'], sort: sp['sort'], brand: sp['brand'], band: sp['band'], seller: sp['seller'], attrs: attrParams(sp) }
  return (
    <Suspense fallback={<CatalogueSkeleton />}>
      <MartBrowse params={p} base="/mart/search" />
    </Suspense>
  )
}
