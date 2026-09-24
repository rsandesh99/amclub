import 'server-only'
import { INDIAN_STATES } from '@amclub/shared'

/**
 * S3.4 — labels the pool pages format on the SERVER and pass down as strings (a date formatted during hydration can
 * differ from the server's and throw the page back to a client render).
 */
export function istShort(iso: string | null): string | null {
  if (!iso) return null
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

export function istDate(ymd: string): string {
  return new Date(`${ymd}T00:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })
}

export function stateLabel(code: string): string {
  return INDIAN_STATES.find((s) => s.value === code)?.label ?? code
}

/** Today in India as YYYY-MM-DD (the earliest a validity date may be). */
export function todayIst(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
}
