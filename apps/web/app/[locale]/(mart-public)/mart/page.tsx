import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { martPageGate } from '@/lib/mart/gate'
import { MART_ENABLED } from '@/lib/flags'
import { MartBrowse, type BrowseParams } from './_browse'

/**
 * AMC Mart home — ISR: the HTML is built once, served from the edge for 60s,
 * and purged the moment a listing is approved/edited (lib/mart/revalidate.ts).
 * Filters and sort are query params; the un-filtered page is the cached one,
 * filtered variants are cached per URL by the same mechanism.
 */
export const revalidate = 60

export async function generateMetadata(): Promise<Metadata> {
  if (!MART_ENABLED) return {}
  const t = await getTranslations('mart')
  return { title: t('title'), description: t('subtitle') }
}

export default async function MartPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  martPageGate()
  const sp = await searchParams
  const params: BrowseParams = { sort: sp['sort'], brand: sp['brand'], band: sp['band'], seller: sp['seller'] }
  return <MartBrowse params={params} base="/mart" />
}
