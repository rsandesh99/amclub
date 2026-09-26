import type { WaErrorKind } from './send'
import type { WaGraphError } from './types'

/**
 * ADR-030 §3 / audit B6 — Graph API errors are parsed and classified, never flattened to text: the code decides
 * whether a send is retried, retried as a template, suppressed, or trips the account circuit breaker. Codes from
 * Meta's Cloud API error reference (the ones this product can meet); an unknown code falls back on the HTTP status.
 */

const CODES: ReadonlyArray<[WaErrorKind, boolean, readonly number[]]> = [
  // re-engagement: more than 24 h since the user last wrote → only a template may go (send.ts retries as one)
  ['outside_window', false, [131047]],
  // the number is not on WhatsApp (or cannot receive) → suppression not_on_whatsapp
  ['not_on_whatsapp', false, [131026]],
  // the user stopped marketing messages from us → suppression marketing_stopped (marketing only)
  ['user_stopped_marketing', false, [131050]],
  // Meta's per-user marketing limit (healthy ecosystem) → failed, no suppression, no retry
  ['marketing_limit', false, [131049]],
  // throughput / pair / spam rate limits → retry later
  ['rate_limited', true, [4, 613, 80007, 130429, 131048, 131056]],
  // template missing / paused / disabled / parameter mismatch → never retried as is
  ['template', false, [132000, 132001, 132005, 132007, 132012, 132015, 132016, 132068, 132069]],
  // the account cannot message at all (policy restriction, locked, payment) → circuit breaker
  ['account_restricted', false, [368, 131031, 131042]],
  // the token is invalid / expired / lacks permission → circuit breaker
  ['auth', false, [0, 3, 10, 190]],
  // a request we built wrong, or a recipient Meta refuses for this message
  ['invalid', false, [100, 131008, 131009, 131021, 131051, 131052, 131053, 130472, 133010]],
  // Meta-side trouble → retry later
  ['server', true, [1, 2, 131000, 131016, 131057]],
]

const BY_CODE = new Map<number, { kind: WaErrorKind; retryable: boolean }>()
for (const [kind, retryable, codes] of CODES) for (const c of codes) BY_CODE.set(c, { kind, retryable })

/** Classify a Graph error code (and the HTTP status when the code is unknown or absent). */
export function classifyWaError(code: number | null | undefined, httpStatus: number | null | undefined): { kind: WaErrorKind; retryable: boolean } {
  if (typeof code === 'number' && BY_CODE.has(code)) return BY_CODE.get(code)!
  if (typeof code === 'number' && code >= 200 && code <= 299) return { kind: 'auth', retryable: false } // permission errors
  if (httpStatus === null || httpStatus === undefined) return code == null ? { kind: 'network', retryable: true } : { kind: 'unknown', retryable: false }
  if (httpStatus === 429) return { kind: 'rate_limited', retryable: true }
  if (httpStatus >= 500) return { kind: 'server', retryable: true }
  if (httpStatus === 401 || httpStatus === 403) return { kind: 'auth', retryable: false }
  if (httpStatus >= 400) return { kind: 'invalid', retryable: false }
  return { kind: 'unknown', retryable: false }
}

/** Kinds after which every further send would fail too: the send path stops calling Meta for a while. */
export function waErrorTripsBreaker(kind: WaErrorKind): boolean {
  return kind === 'account_restricted' || kind === 'auth'
}

/** Parse a Graph error body `{ error: { code, error_subcode, message, error_user_title, error_data } }`. */
export function parseGraphError(json: unknown, httpStatus: number | null): WaGraphError {
  const e = (json && typeof json === 'object' ? (json as { error?: unknown }).error : null) as
    | { code?: unknown; error_subcode?: unknown; message?: unknown; error_user_title?: unknown; error_user_msg?: unknown; error_data?: { details?: unknown } }
    | null
    | undefined
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null)
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const message = str(e?.message) || str(e?.error_data?.details) || (httpStatus ? `http_${httpStatus}` : 'network')
  return {
    code: num(e?.code),
    subcode: num(e?.error_subcode),
    title: (str(e?.error_user_title) || message).slice(0, 200),
    message: message.slice(0, 500),
    httpStatus,
  }
}
