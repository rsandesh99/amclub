import type { MetadataRoute } from 'next'

const BASE = process.env['NEXT_PUBLIC_APP_URL'] ?? 'https://amclub.in'

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
