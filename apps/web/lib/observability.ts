import * as Sentry from '@sentry/nextjs'

/**
 * Handled operational failures → Sentry (audit M35). A handled error never
 * reaches Next's onRequestError hook, so crons, money sweepers and the rate
 * limiter report here explicitly. Without SENTRY_DSN the SDK is not initialised
 * and these are no-ops. Never throws: reporting must not break the caller.
 * Callers keep their own console line (Vercel logs); this adds the alertable event.
 */

type Level = 'fatal' | 'error' | 'warning' | 'info'

export interface OpsReportOptions {
  tags?: Record<string, string | number | boolean>
  extra?: Record<string, unknown>
  level?: Level
}

function scope(context: string, opts: OpsReportOptions) {
  return {
    level: opts.level ?? 'error',
    tags: { context, ...(opts.tags ?? {}) },
    ...(opts.extra ? { extra: opts.extra } : {}),
  }
}

/** An exception that was caught and handled (the run went on, or answered with an error). */
export function reportOpsError(error: unknown, context: string, opts: OpsReportOptions = {}): void {
  try {
    Sentry.captureException(error, scope(context, opts))
  } catch {
    /* never break the caller */
  }
}

/** A run that finished but reported a problem (no exception to attach). Stable `message` = one Sentry issue. */
export function reportOpsIssue(message: string, context: string, opts: OpsReportOptions = {}): void {
  try {
    Sentry.captureMessage(message, scope(context, { level: 'warning', ...opts }))
  } catch {
    /* never break the caller */
  }
}
