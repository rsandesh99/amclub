import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Standard Webhooks signature check (standardwebhooks.com), the scheme Supabase
 * Auth hooks sign with (audit H3):
 * - the secret is "v1,whsec_<base64 key>" (the prefixes are optional here);
 * - the signed content is `${webhook-id}.${webhook-timestamp}.${raw body}`;
 * - `webhook-signature` holds space-separated "v1,<base64 HMAC-SHA256>" values.
 * The timestamp must be within `toleranceSec` of now, so a captured request
 * cannot be replayed later.
 */
export function verifyStandardWebhook(
  secret: string,
  headers: Headers,
  body: string,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): boolean {
  const id = headers.get('webhook-id')
  const ts = headers.get('webhook-timestamp')
  const sigs = headers.get('webhook-signature')
  if (!id || !ts || !sigs) return false
  const t = Number(ts)
  if (!Number.isInteger(t) || Math.abs(nowSec - t) > toleranceSec) return false
  const key = Buffer.from(secret.replace(/^v1,/, '').replace(/^whsec_/, ''), 'base64')
  if (key.length < 16) return false
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest()
  for (const part of sigs.split(' ')) {
    const [version, sig] = part.split(',')
    if (version !== 'v1' || !sig) continue
    const got = Buffer.from(sig, 'base64')
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true
  }
  return false
}

/** Sign like a Standard Webhooks sender (tests and rigs). */
export function signStandardWebhook(secret: string, id: string, ts: number, body: string): string {
  const key = Buffer.from(secret.replace(/^v1,/, '').replace(/^whsec_/, ''), 'base64')
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`
}
