/**
 * Sanitize a post-auth `next` redirect target. Prevents open-redirect attacks:
 * only same-origin, absolute internal paths are allowed. Returns null when the
 * value is missing or unsafe (the caller should fall back to a role home).
 */
export function safeNext(next: string | null | undefined): string | null {
  if (!next) return null
  let value = next.trim()
  // Tolerate a single layer of URL-encoding (callbacks pass it encoded).
  try {
    value = decodeURIComponent(value)
  } catch {
    return null
  }
  // Must be an absolute internal path…
  if (!value.startsWith('/')) return null
  // …but not protocol-relative ("//evil.com") or backslash tricks ("/\evil").
  if (value.startsWith('//') || value.startsWith('/\\')) return null
  // Never bounce back into auth routes (avoids loops).
  if (/^\/(login|signup|partner\/signup)(\/|\?|$)/.test(value)) return null
  return value
}
