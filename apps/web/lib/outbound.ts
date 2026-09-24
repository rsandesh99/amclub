/**
 * Deadlines for every outbound vendor call (audit M37). A slow vendor must never
 * hold a user request, a webhook or a cron batch until the function itself times
 * out: each call aborts after its budget and the caller's existing error path
 * runs (a failed notification channel, a KYC "try again", an unconfirmed payout).
 * Payments: an aborted Razorpay call surfaces as a network error, which the
 * payout path already treats as "outcome unknown", never as a definite failure.
 */
export const OUTBOUND_TIMEOUT_MS = {
  /** Resend email, WhatsApp (Meta Cloud / Interakt). */
  notify: 5_000,
  /** Surepass KYC (GSTIN / bank / Udyam): slower registry lookups. */
  kyc: 10_000,
  /** Razorpay API (orders, refunds, transfers, lookups). */
  payments: 10_000,
  /** Sarvam speech-to-text: uploads a clip of up to a minute or two. */
  stt: 25_000,
  /** Sarvam text-to-speech. */
  tts: 10_000,
  /** The agent runtime (Fly) and other internal calls. */
  internal: 5_000,
  /** Public images fetched to render a share card. */
  image: 5_000,
} as const

/** A fetch that aborts after `ms`, keeping any signal the caller already passed (for SDKs that take a fetch). */
export function fetchWithTimeout(ms: number): typeof fetch {
  return (input, init) => {
    const deadline = AbortSignal.timeout(ms)
    return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline })
  }
}
