import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'
import { withSentryConfig } from '@sentry/nextjs'

const withNextIntl = createNextIntlPlugin('./i18n/request.ts')

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
