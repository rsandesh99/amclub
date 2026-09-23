/**
 * Dates in IST, per the v3 content rules (PRD §3.7): "Mon 29 Sep"; relative
 * ("in 5 hours") only inside 48 h; Latin digits in every locale (D-PRD7).
 * Client-safe (no server imports).
 */
const TZ = 'Asia/Kolkata'
const tag = (locale: string) => `${['hi', 'te', 'ta'].includes(locale) ? locale : 'en'}-IN-u-nu-latn`

export function istDay(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(tag(locale), { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso))
}

export function istDayTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(tag(locale), { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}

/** A deadline: relative within 48 h ("in 5 hours"), else the IST day. */
export function istDeadline(iso: string, locale: string, now: number = Date.now()): string {
  const ms = Date.parse(iso) - now
  if (ms > 0 && ms < 48 * 3600 * 1000) {
    const rtf = new Intl.RelativeTimeFormat(tag(locale), { numeric: 'auto' })
    const hours = Math.round(ms / 3600000)
    return hours < 1 ? rtf.format(Math.max(1, Math.round(ms / 60000)), 'minute') : rtf.format(hours, 'hour')
  }
  return istDay(iso, locale)
}
