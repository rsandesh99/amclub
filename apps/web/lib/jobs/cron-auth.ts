import type { NextRequest } from 'next/server'

/**
 * Authorise a cron invocation. Vercel Cron sends `Authorization: Bearer
 * $CRON_SECRET` when CRON_SECRET is configured. If no secret is set, allow only
 * outside production (local testing). Never open in prod without a secret.
 */
export function verifyCron(request: NextRequest): boolean {
  const secret = process.env['CRON_SECRET']
  const auth = request.headers.get('authorization')
  if (secret) return auth === `Bearer ${secret}`
  return process.env['NODE_ENV'] !== 'production'
}
