import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env['SENTRY_DSN'],
  // production | preview | development on Vercel (NODE_ENV is 'production' for previews too), so preview noise
  // never lands in the production environment's alerts (audit M35).
  environment: process.env['VERCEL_ENV'] ?? process.env['NODE_ENV'],
  tracesSampleRate: process.env['NODE_ENV'] === 'production' ? 0.1 : 1.0,
  debug: false,
})
