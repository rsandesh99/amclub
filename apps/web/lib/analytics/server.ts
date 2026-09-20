import 'server-only'

/**
 * Server-side PostHog capture (S1.1). apps/web only ships posthog-js on the
 * client; server events use the HTTP capture API directly so no SDK is added.
 * Best-effort: no key ⇒ no-op, 2 s timeout, never throws, never awaited on the
 * request's critical path by callers (fire-and-forget). Event names live in
 * DESIGN.md Appendix A.
 */
const KEY = process.env['NEXT_PUBLIC_POSTHOG_KEY']
const HOST = (process.env['NEXT_PUBLIC_POSTHOG_HOST'] ?? 'https://eu.posthog.com').replace(/\/$/, '')

export function captureServerEvent(distinctId: string, event: string, properties: Record<string, unknown> = {}): void {
  if (!KEY || KEY === 'phc_placeholder') return
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 2000)
  fetch(`${HOST}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: KEY, event, distinct_id: distinctId, properties: { device: 'server', ...properties }, timestamp: new Date().toISOString() }),
    signal: ctrl.signal,
    cache: 'no-store',
  })
    .catch(() => undefined)
    .finally(() => clearTimeout(timer))
}
