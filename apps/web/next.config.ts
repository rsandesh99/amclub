import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'
import { withSentryConfig } from '@sentry/nextjs'

const withNextIntl = createNextIntlPlugin('./i18n/request.ts')

// Security headers (Phase 8 §8 / OWASP). CSP notes:
//  - script-src needs 'unsafe-inline' for Next's bootstrap inline scripts
//    (nonce plumbing is the strict upgrade path — docs/SECURITY_CHECKLIST.md);
//    no 'unsafe-eval' in production.
//  - Razorpay checkout: script + frame + connect. Turnstile: script + frame.
//  - PostHog: connect only (SDK bundled, loaded after idle). Sentry: connect
//    + script for browser.sentry-cdn.com — Session Replay is lazy-loaded from
//    there after idle (sentry.client.config.ts) instead of shipping in the
//    first-visit bundle.
//  - microphone=(self) — Voice RFQ records on our own origin only.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com https://challenges.cloudflare.com https://browser.sentry-cdn.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https://*.supabase.co",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.razorpay.com https://*.posthog.com https://*.sentry.io https://challenges.cloudflare.com",
  "frame-src https://api.razorpay.com https://checkout.razorpay.com https://challenges.cloudflare.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ')

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=(self), payment=(self)' },
]

const nextConfig: NextConfig = {
  // Transpile internal workspace packages (source exports, not compiled)
  transpilePackages: ['@amclub/shared', '@amclub/db'],

  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.supabase.co',
      },
      // Local Supabase stand-ins (supabase start / the screenshot rig). Never
      // matches in production, where NEXT_PUBLIC_SUPABASE_URL is *.supabase.co.
      ...(process.env['NEXT_PUBLIC_SUPABASE_URL']?.startsWith('http://localhost')
        ? [{ protocol: 'http' as const, hostname: 'localhost' }, { protocol: 'http' as const, hostname: '127.0.0.1' }]
        : []),
    ],
    // Product cards render at 80–160px; the hero at ≤600px. Small, exact
    // sizes keep the optimizer's output tiny on 4G.
    deviceSizes: [390, 640, 828, 1080, 1280],
    imageSizes: [80, 120, 160, 240, 320],
    minimumCacheTTL: 31536000,
  },

  async headers() {
    return [{ source: '/(.*)', headers: SECURITY_HEADERS }]
  },

  // Chunking: the public header/footer, account menu, language switcher and
  // shared providers are used by every route group. Left to the defaults,
  // webpack folded them into the FIRST page entry that used them — the
  // gateway wizard — so /mart and /services downloaded the whole wizard
  // (15 KB gz) to get a 2 KB header. One named "shell" chunk, cached once.
  webpack(config, { isServer, dev }) {
    const split = config.optimization?.splitChunks
    if (!isServer && !dev && split && typeof split === 'object') {
      split.cacheGroups = {
        ...(split.cacheGroups ?? {}),
        shell: {
          name: 'shell',
          test: /[\\/]components[\\/](catalog|shell|providers|ui|pwa)[\\/]|[\\/]i18n[\\/]navigation/,
          minChunks: 1,
          priority: 40,
          enforce: true,
          reuseExistingChunk: true,
        },
      }
    }
    return config
  },

  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
}

const intlConfig = withNextIntl(nextConfig)

// Only add Sentry when DSN is available (skipped in dev without credentials)
export default process.env['SENTRY_DSN']
  ? withSentryConfig(intlConfig, {
      org: process.env['SENTRY_ORG'] ?? '',
      project: process.env['SENTRY_PROJECT'] ?? '',
      silent: !process.env['CI'],
      widenClientFileUpload: true,
      disableLogger: true,
      automaticVercelMonitors: true,
    })
  : intlConfig
