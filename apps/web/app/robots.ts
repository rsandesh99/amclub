import type { MetadataRoute } from 'next'
import { getSiteUrl } from '@/lib/site-url'

const BASE = getSiteUrl()

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Keep authenticated app surfaces and API out of the index.
        disallow: ['/app', '/partner', '/admin', '/api', '/login', '/signup'],
      },
    ],
    sitemap: `${BASE}/sitemap.xml`,
    host: BASE,
  }
}
