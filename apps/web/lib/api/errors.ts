import { NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'

/**
 * Standard 500 envelope. Logs the full error server-side (Vercel logs / Sentry)
 * and returns a generic, non-leaking message to the client — raw Postgres
 * `error.message` strings can disclose table/column/constraint names.
 *
 * Zod `.flatten()` field errors are intentionally NOT routed through here:
 * those are safe, intended validation feedback for the client form.
 */
export function serverError(context: string, error: unknown): NextResponse {
  console.error(context, error)
  // A handled 500 never reaches Next's error hook — report it explicitly (no-op without SENTRY_DSN).
  Sentry.captureException(error, { tags: { context } })
  return NextResponse.json(
    { error: 'Something went wrong, please try again.' },
    { status: 500 },
  )
}
