import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { pickLocale } from '@amclub/shared'
import { martPageGate } from '@/lib/mart/gate'
import { MART_ENABLED } from '@/lib/flags'
import { listMartCategories } from '@/lib/mart/config'
import { MartBrowse, attrParams, type BrowseParams } from '../../_browse'

/**
 * Category browse — ISR per category, rendered ON DEMAND (first hit builds it,
 * revalidate purges it; lib/mart/revalidate.ts purges on mutation), exactly
 * like /mart/p/[id]. No generateStaticParams: it used to enumerate categories
 * from the database at BUILD time, which (a) coupled the build to the DB and
 * the flag's build-time value and (b) produced an empty prerender set when
 * the flag was off at build, after which every /mart/c/* request 500'd on
 * Vercel with the flag on (2026-09-19 demo incident). On-demand ISR has no
 * build-time state to get wrong.
 */
export const revalidate = 60

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  if (!MART_ENABLED) return {}
  const { slug } = await params
  const [t, locale, cats] = await Promise.all([getTranslations('mart'), getLocale(), listMartCategories()])
  const cat = cats.find((c) => c.slug === slug)
  return cat ? { title: `${pickLocale(cat.name_i18n, locale)} · ${t('title')}`, description: t('subtitle') } : {}
}

export default async function MartCategoryPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  martPageGate()
  const [{ slug }, sp] = await Promise.all([params, searchParams])
  const cats = await listMartCategories()
  if (!cats.some((c) => c.slug === slug)) notFound()
  const p: BrowseParams = { category: slug, sort: sp['sort'], brand: sp['brand'], band: sp['band'], seller: sp['seller'], attrs: attrParams(sp) }
  return <MartBrowse params={p} base={`/mart/c/${slug}`} />
}
