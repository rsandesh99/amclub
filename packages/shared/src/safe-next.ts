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
  // URL parsers drop tab / CR / LF and read "\" as "/", so "/<TAB>/evil.com"
  // becomes "//evil.com" in the browser (audit M6). No control characters or
  // backslashes anywhere, and the value must resolve to this origin.
  if (/[\u0000-\u001F\u007F\\]/.test(value)) return null
  try {
    if (new URL(value, 'https://amclub.invalid').origin !== 'https://amclub.invalid') return null
  } catch {
    return null
  }
  // Never bounce back into auth routes (avoids loops).
  if (/^\/(login|signup|partner\/signup)(\/|\?|$)/.test(value)) return null
  return value
}

/**
 * E0 (U1) — carry a sanitized `next` intent onto a wizard URL, so a brand-new
 * user who was auth-walled on their way to checkout (or an RFQ) lands back on
 * that exact page once the wizard finishes. Unsafe or missing `next` → the
 * path unchanged. Never nests the wizard into itself: when `next` IS the
 * wizard (possibly carrying its own `next`), that URL is used as-is.
 */
export function withNext(path: string, next: string | null | undefined): string {
  const safe = safeNext(next)
  if (!safe) return path
  if (safe.split('?')[0] === path.split('?')[0]) return safe
  return `${path}${path.includes('?') ? '&' : '?'}next=${encodeURIComponent(safe)}`
}
