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

export interface Pricing {
  listPaise: number
  discountedPaise: number
  memberPaise: number
  hasDiscount: boolean
  hasMemberExtra: boolean
  discountPct: number
  memberExtraPct: number
}

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
  }
}

export function pickI18n(map: { en: string; hi?: string } | null | undefined, locale: string): string {
  if (!map) return ''
  if (locale === 'hi' && map.hi) return map.hi
  return map.en
}

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
