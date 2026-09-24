/** Money + i18n helpers for the mobile app (mirror of apps/web/lib/format). */

const inr0 = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

export function formatINR(paise: number): string {
  return inr0.format(Math.round(paise / 100))
}

const inr2 = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** Paise-exact rendering for goods unit prices (₹8.50 per rod) — whole-rupee
 *  amounts drop the decimals. Input is always server-computed paise. */
export function formatINRExact(paise: number): string {
  return paise % 100 === 0 ? inr0.format(paise / 100) : inr2.format(paise / 100)
}

// Experience v3 N16: package prices are the server's `display` (shared
// priceDisplay); the client-side computePricing was removed.

/** E14 FR-14.2 — the ONE picker ({ en, hi?, te?, ta? }, own slot else English), shared with the web. */
export { pickI18n } from '@amclub/shared'

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => /[a-zA-Z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
}

export function formatResponseTime(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null
  if (minutes < 60) return `~${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `~${hours}h`
  return `~${Math.round(hours / 24)}d`
}
