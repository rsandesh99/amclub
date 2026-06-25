import type { MetadataRoute } from 'next'
import { getAllPublicSlugs, getCategories } from '@/lib/catalog/queries'
import { CATEGORY_SLUGS } from '@amclub/shared'

const BASE = process.env['NEXT_PUBLIC_APP_URL'] ?? 'https://amclub.in'

// Build a localized URL: en is unprefixed, hi is /hi (localePrefix: 'as-needed').
function url(locale: string, path: string) {
  const prefix = locale === 'en' ? '' : `/${locale}`
  return `${BASE}${prefix}${path === '/' ? '' : path}` || BASE
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = []

  const staticPaths = ['/', '/services']
  const categoryPaths = (await getCategories().catch(() => []))
    .map((c) => `/services/${c.slug}`)
  const fallbackCats = CATEGORY_SLUGS.map((s) => `/services/${s}`)

  const { providers, packages } = await getAllPublicSlugs().catch(() => ({
    providers: [] as string[],
    packages: [] as { providerSlug: string; packageSlug: string }[],
  }))

  const providerPaths = providers.map((s) => `/p/${s}`)
  const packagePaths = packages.map((p) => `/p/${p.providerSlug}/${p.packageSlug}`)

  const allPaths = [
    ...staticPaths,
    ...(categoryPaths.length > 0 ? categoryPaths : fallbackCats),
    ...providerPaths,
    ...packagePaths,
  ]

  for (const path of allPaths) {
    entries.push({
      url: url('en', path),
      lastModified: new Date(),
      changeFrequency: path === '/' ? 'daily' : 'weekly',
      priority: path === '/' ? 1 : path.startsWith('/p/') ? 0.7 : 0.8,
      alternates: {
        languages: {
          en: url('en', path),
          hi: url('hi', path),
        },
      },
    })
  }

  return entries
}
