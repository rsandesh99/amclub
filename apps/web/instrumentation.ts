import * as Sentry from '@sentry/nextjs'

export async function register() {
  if (process.env['NEXT_RUNTIME'] === 'nodejs' && process.env['SENTRY_DSN']) {
    await import('./sentry.server.config')
  }

  if (process.env['NEXT_RUNTIME'] === 'edge' && process.env['SENTRY_DSN']) {
    await import('./sentry.edge.config')
  }
}

// Unhandled route/render errors (Next 15 hook) — no-op when Sentry isn't initialised.
export const onRequestError = Sentry.captureRequestError
