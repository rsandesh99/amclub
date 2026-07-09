import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'
import { withSentryConfig } from '@sentry/nextjs'

const withNextIntl = createNextIntlPlugin('./i18n/request.ts')

// Security headers (Phase 8 §8 / OWASP). CSP notes:
//  - script-src needs 'unsafe-inline' for Next's bootstrap inline scripts
//    (nonce plumbing is the strict upgrade path — docs/SECURITY_CHECKLIST.md);
//    no 'unsafe-eval' in production.
//  - Razorpay checkout: script + frame + connect. Turnstile: script + frame.
//  - PostHog/Sentry: connect only (SDKs are bundled, not CDN-loaded).
//  - microphone=(self) — Voice RFQ records on our own origin only.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com https://challenges.cloudflare.com",
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
    ],
  },

  async headers() {
    return [{ source: '/(.*)', headers: SECURITY_HEADERS }]
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
