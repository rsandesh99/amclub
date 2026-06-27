import { NextResponse } from 'next/server'

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
  return NextResponse.json(
    { error: 'Something went wrong, please try again.' },
    { status: 500 },
  )
}
