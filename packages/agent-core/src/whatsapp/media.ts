/**
 * Inbound media limits (audit M34). WhatsApp media is fetched from the vendor
 * by the wa.inbound JOB (never by the public webhook), and every download is
 * bounded: a timeout on each fetch, a MIME allow-list checked before the bytes
 * are read, a Content-Length check, and a streamed byte cap (a missing or lying
 * Content-Length cannot make the one runtime machine buffer an unbounded body).
 */

export interface MediaLimits {
  /** Largest object accepted, in bytes. */
  maxBytes: number
  /** Timeout for EACH vendor fetch (the lookup and the bytes), in ms. */
  timeoutMs: number
  /** Accepted base MIME types (lower-case, no parameters). */
  allowedMime: readonly string[]
}

/** What the agents consume: photos (onboarding, procurement), voice notes (STT) and PDFs (document intake). */
export const WA_MEDIA_ALLOWED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
  'application/pdf',
] as const

/** 10 MB: above every agent consumer's own cap (STT 3 MB), well inside the 512 MB machine. */
export const DEFAULT_MEDIA_LIMITS: MediaLimits = { maxBytes: 10 * 1024 * 1024, timeoutMs: 20_000, allowedMime: WA_MEDIA_ALLOWED_MIME }

/** Limits from env (WA_MEDIA_MAX_BYTES, WA_MEDIA_TIMEOUT_MS), clamped; the allow-list is code. */
export function mediaLimitsFromEnv(env: Record<string, string | undefined> = process.env): MediaLimits {
  const int = (v: string | undefined, d: number, lo: number, hi: number) => {
    const n = Number(v)
    return Number.isInteger(n) && n >= lo && n <= hi ? n : d
  }
  return {
    maxBytes: int(env['WA_MEDIA_MAX_BYTES'], DEFAULT_MEDIA_LIMITS.maxBytes, 64 * 1024, 32 * 1024 * 1024),
    timeoutMs: int(env['WA_MEDIA_TIMEOUT_MS'], DEFAULT_MEDIA_LIMITS.timeoutMs, 1_000, 60_000),
    allowedMime: WA_MEDIA_ALLOWED_MIME,
  }
}

export type MediaRefusal = 'too_large' | 'mime_not_allowed' | 'timeout' | 'http' | 'bad_ref'

/** A download the limits refused (or the vendor failed). `code` is stable for logs and tests. */
export class MediaRefusedError extends Error {
  constructor(public code: MediaRefusal, detail: string) {
    super(`media_refused:${code}:${detail}`)
    this.name = 'MediaRefusedError'
  }
}

export function baseMime(mime: string | null | undefined): string {
  return String(mime ?? '').split(';')[0]!.trim().toLowerCase()
}

export function mimeAllowed(mime: string | null | undefined, limits: MediaLimits = DEFAULT_MEDIA_LIMITS): boolean {
  const m = baseMime(mime)
  return !!m && limits.allowedMime.includes(m)
}

/** fetch with a per-call timeout; an abort becomes MediaRefusedError('timeout'). */
export async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    const name = (e as { name?: string }).name
    if (name === 'TimeoutError' || name === 'AbortError') throw new MediaRefusedError('timeout', `${timeoutMs}ms`)
    throw new MediaRefusedError('http', (e as Error).message)
  }
}

/**
 * Read a response body with a hard cap: refuse on a declared Content-Length above
 * the cap, then count the streamed bytes and cancel the stream the moment the cap
 * is passed (a missing or false Content-Length changes nothing).
 */
export async function readCappedBody(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    throw new MediaRefusedError('too_large', `declared ${declared} > ${maxBytes}`)
  }
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > maxBytes) throw new MediaRefusedError('too_large', `${buf.byteLength} > ${maxBytes}`)
    return buf
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new MediaRefusedError('too_large', `streamed > ${maxBytes}`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/** Storage extension for an allowed MIME (the object path the agents read back). */
export function mediaExtension(mime: string): string {
  const m = baseMime(mime)
  if (m === 'image/jpeg') return 'jpg'
  if (m === 'image/png') return 'png'
  if (m === 'image/webp') return 'webp'
  if (m === 'application/pdf') return 'pdf'
  if (m === 'audio/ogg' || m === 'audio/opus') return 'ogg'
  if (m === 'audio/mpeg') return 'mp3'
  if (m === 'audio/mp4' || m === 'audio/aac') return 'm4a'
  if (m === 'audio/amr') return 'amr'
  return 'bin'
}
