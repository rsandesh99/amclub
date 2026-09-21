/**
 * Server-side PostHog capture for the runtime (S1.6) — the same HTTP capture
 * the web app uses (apps/web/lib/analytics/server.ts): no SDK, best-effort,
 * 2 s timeout, never throws, never awaited on the job's critical path. Event
 * names live in DESIGN.md Appendix A.
 */
const KEY = process.env['NEXT_PUBLIC_POSTHOG_KEY']
const HOST = (process.env['NEXT_PUBLIC_POSTHOG_HOST'] ?? 'https://eu.posthog.com').replace(/\/$/, '')

export function captureRuntimeEvent(distinctId: string, event: string, properties: Record<string, unknown> = {}): void {
  if (!KEY || KEY === 'phc_placeholder') return
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 2000)
  fetch(`${HOST}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: KEY, event, distinct_id: distinctId, properties: { device: 'runtime', ...properties }, timestamp: new Date().toISOString() }),
    signal: ctrl.signal,
  })
    .catch(() => undefined)
    .finally(() => clearTimeout(timer))
}
