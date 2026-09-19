import 'server-only'
import { createHmac } from 'node:crypto'

/**
 * Minimal HS256 JWT signer (ADR-008 §3 delegated identity). The token endpoint
 * mints a run-bound JWT signed with SUPABASE_JWT_SECRET; Supabase validates it
 * on the actual /api/v1 call, so RLS applies as the delegated user. No `jose`
 * dependency — HS256 is a HMAC over base64url segments.
 *
 * We only SIGN here. We never verify a signature in web code: getAuthedSupabase
 * hands the token to Supabase, which validates it. decodeJwtClaims reads claims
 * of an ALREADY-VALIDATED token (scope enforcement), never as a trust boundary.
 */

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url')
}

export function signHs256(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const seg = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = createHmac('sha256', secret).update(seg).digest('base64url')
  return `${seg}.${sig}`
}

/** Decode (NOT verify) a JWT payload. Returns null on any malformed input. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const json = Buffer.from(parts[1] as string, 'base64url').toString('utf8')
    const claims = JSON.parse(json)
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null
  } catch {
    return null
  }
}
