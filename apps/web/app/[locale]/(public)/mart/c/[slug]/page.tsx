import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { pickLocale } from '@amclub/shared'
import { martPageGate } from '@/lib/mart/gate'
import { MART_ENABLED } from '@/lib/flags'
import { listMartCategories } from '@/lib/mart/config'
import { MartBrowse, type BrowseParams } from '../../_browse'

/** Category browse — ISR per category (built on first hit, purged on mutation). */
export const revalidate = 60
export const dynamicParams = true

export async function generateStaticParams() {
  if (!MART_ENABLED) return []
  const cats = await listMartCategories()
  return cats.filter((c) => !c.bis_blocked).map((c) => ({ slug: c.slug }))
}

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
  const p: BrowseParams = { category: slug, sort: sp['sort'], brand: sp['brand'], band: sp['band'], seller: sp['seller'] }
  return <MartBrowse params={p} base={`/mart/c/${slug}`} />
}
