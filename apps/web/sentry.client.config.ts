import * as Sentry from '@sentry/nextjs'

/**
 * Session Replay is the heaviest part of the browser SDK (~55 KB gzipped) and
 * only matters once an error has happened. It is fetched from Sentry's CDN
 * (allowed in CSP script-src) after the page is idle and attached at runtime;
 * errors that occur before that are still captured by the core SDK. On the
 * first 4G visit the catalogue page therefore ships no replay code at all.
 */
Sentry.init({
  dsn: process.env['NEXT_PUBLIC_SENTRY_DSN'],
  // Vercel exposes its environment to the browser build as NEXT_PUBLIC_VERCEL_ENV (audit M35).
  environment: process.env['NEXT_PUBLIC_VERCEL_ENV'] ?? process.env['NODE_ENV'],
  tracesSampleRate: process.env['NODE_ENV'] === 'production' ? 0.1 : 1.0,
  debug: false,
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0.05,
})

function attachReplay() {
  Sentry.lazyLoadIntegration('replayIntegration')
    .then((replayIntegration) => {
      Sentry.addIntegration(replayIntegration({ maskAllText: true, blockAllMedia: true }))
    })
    .catch(() => {
      /* offline or CDN blocked — core error capture still works */
    })
}

if (typeof window !== 'undefined' && process.env['NEXT_PUBLIC_SENTRY_DSN']) {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
  const schedule = () => (w.requestIdleCallback ? w.requestIdleCallback(attachReplay, { timeout: 8000 }) : setTimeout(attachReplay, 4000))
  if (document.readyState === 'complete') schedule()
  else window.addEventListener('load', schedule, { once: true })
}
