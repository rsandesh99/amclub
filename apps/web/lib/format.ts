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

export interface Pricing {
  listPaise: number
  /** After the public discount. */
  discountedPaise: number
  /** After the public discount AND the member-only extra discount. */
  memberPaise: number
  hasDiscount: boolean
  hasMemberExtra: boolean
  /** Public discount as whole percent, e.g. 10. */
  discountPct: number
  /** Member extra discount as whole percent. */
  memberExtraPct: number
  /** Rupees-off paise from list → discounted (public). */
  savingsPaise: number
}

/**
 * Compute the price block from a package's stored fields.
 * discount_bps / member_extra_discount_bps are basis points (1000 = 10%).
 */
export function computePricing(input: {
  pricePaise: number
  discountBps: number
  memberExtraDiscountBps: number
}): Pricing {
  const { pricePaise, discountBps, memberExtraDiscountBps } = input
  const discountedPaise = Math.round(pricePaise * (1 - discountBps / 10000))
  const memberPaise = Math.round(discountedPaise * (1 - memberExtraDiscountBps / 10000))
  return {
    listPaise: pricePaise,
    discountedPaise,
    memberPaise,
    hasDiscount: discountBps > 0,
    hasMemberExtra: memberExtraDiscountBps > 0,
    discountPct: Math.round(discountBps / 100),
    memberExtraPct: Math.round(memberExtraDiscountBps / 100),
    savingsPaise: pricePaise - discountedPaise,
  }
}

/** "Responds in ~3h" style label from median response minutes. */
export function formatResponseTime(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null
  if (minutes < 60) return `~${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `~${hours}h`
  const days = Math.round(hours / 24)
  return `~${days}d`
}

/** Pick a localized string from an {en, hi} map, falling back to en. */
export function pickI18n(
  map: { en: string; hi?: string } | null | undefined,
  locale: string,
): string {
  if (!map) return ''
  if (locale === 'hi' && map.hi) return map.hi
  return map.en
}

/** Initials for a logo-less avatar, e.g. "Sharma & Associates" → "SA". */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => /[a-zA-Z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
}
