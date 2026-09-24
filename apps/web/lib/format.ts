/**
 * Money + pricing helpers. Money is stored as bigint paise (§2.5 rule 6).
 * Render in INR with Indian digit grouping. Never do money math in floats
 * beyond the final rupee display rounding.
 */

const inr0 = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

/** Format paise as a whole-rupee INR string, e.g. 199900 → "₹1,999". */
export function formatINR(paise: number): string {
  return inr0.format(Math.round(paise / 100))
}

const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * Exact INR: whole rupees stay whole ("₹450"), sub-rupee amounts show paise
 * ("₹4.50"). AMC Mart unit prices are commonly sub-rupee (fasteners, nuts),
 * so goods surfaces use this for per-unit and line values; order totals keep
 * formatINR.
 */
export function formatINRExact(paise: number): string {
  return paise % 100 === 0 ? inr0.format(paise / 100) : inr2.format(paise / 100)
}

// Experience v3 N16: package prices are the server's `display` (shared
// priceDisplay); the client-side computePricing was removed.

/** "Responds in ~3h" style label from median response minutes. */
export function formatResponseTime(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null
  if (minutes < 60) return `~${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `~${hours}h`
  const days = Math.round(hours / 24)
  return `~${days}d`
}

/** E14 FR-14.2 — the ONE picker ({ en, hi?, te?, ta? }, own slot else English), shared with mobile. */
export { pickI18n } from '@amclub/shared'

/** Initials for a logo-less avatar, e.g. "Sharma & Associates" → "SA". */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => /[a-zA-Z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
}
