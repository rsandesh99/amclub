/**
 * Canonical absolute base URL for the site (no trailing slash). Used for
 * sitemap, robots, and JSON-LD/OG absolute URLs.
 *
 * Resolution order:
 *   1. NEXT_PUBLIC_APP_URL  — explicit override (ignored if it's localhost)
 *   2. VERCEL_PROJECT_PRODUCTION_URL — Vercel injects this automatically on
 *      every deployment (the stable production domain, no protocol)
 *   3. VERCEL_URL — the per-deployment URL (preview deployments)
 *   4. http://localhost:3000 — local dev fallback
 *
 * This means production gets correct absolute URLs with zero dashboard config.
 */
export function getSiteUrl(): string {
  const explicit = process.env['NEXT_PUBLIC_APP_URL']
  if (explicit && !explicit.includes('localhost')) {
    return explicit.replace(/\/$/, '')
  }
  const prod = process.env['VERCEL_PROJECT_PRODUCTION_URL']
  if (prod) return `https://${prod}`
  const deployment = process.env['VERCEL_URL']
  if (deployment) return `https://${deployment}`
  return 'http://localhost:3000'
}
