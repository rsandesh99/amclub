import 'server-only'

/**
 * Notification values formatted on the server (rules 6 and 7): money from integer paise, always with its two paise
 * digits (₹1,234.56, never rounded to the rupee — audit section 7), and deadlines in IST.
 */

const group = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

/** 123456 → "₹1,234.56"; integer arithmetic on safe integers (paise), no float rupees. */
export function formatPaise(paise: number | string): string {
  const p = Math.trunc(Number(paise))
  if (!Number.isSafeInteger(p)) return '₹—'
  const abs = Math.abs(p)
  const rupees = (abs - (abs % 100)) / 100
  return `${p < 0 ? '-' : ''}₹${group.format(rupees)}.${String(abs % 100).padStart(2, '0')}`
}

type I18nMap = { en: string; hi: string; te?: string; ta?: string }

const INTL_LOCALE = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN', ta: 'ta-IN' } as const

/** "27 Sept, 9:00 pm" in IST, per notification locale (a four-language value for notifyText). */
export function istDateTime(iso: string | Date): I18nMap {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  const fmt = (l: keyof typeof INTL_LOCALE) =>
    `${d.toLocaleString(INTL_LOCALE[l], { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} IST`
  return { en: fmt('en'), hi: fmt('hi'), te: fmt('te'), ta: fmt('ta') }
}

/** Whole hours left until `iso` (at least 1). */
export function hoursUntil(iso: string | Date, now = new Date()): number {
  const t = (typeof iso === 'string' ? new Date(iso) : iso).getTime()
  return Math.max(1, Math.round((t - now.getTime()) / 3_600_000))
}
