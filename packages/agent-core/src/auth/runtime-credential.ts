import { createHmac, timingSafeEqual } from 'node:crypto'
import { agentPersonaSchema, type AgentPersona } from '@amclub/shared'

/**
 * Runtime credential (ADR-009 §6). When the always-on runtime calls
 * POST /api/v1/agent/token to mint a delegated JWT, it presents this HMAC
 * instead of a session cookie: `Authorization: AMC-Runtime <credential>`. The
 * credential is HMAC-SHA256(AGENT_RUNTIME_SECRET, `userId|persona|runId|ts`)
 * with a +/-5 min window, so a leaked credential expires quickly and the
 * runtime never holds a user's actual session. The token endpoint ALSO requires
 * an active agent_grants row — the HMAC only proves "the runtime said so".
 */

export interface RuntimeCredentialClaims {
  userId: string
  persona: AgentPersona
  runId: string
  /** Unix seconds. */
  ts: number
}

const SEP = '.'

function mac(secret: string, userId: string, persona: string, runId: string, ts: number): string {
  return createHmac('sha256', secret).update(`${userId}|${persona}|${runId}|${ts}`).digest('hex')
}

/** Produce the credential string the runtime puts after `AMC-Runtime `. */
export function signRuntimeCredential(
  secret: string,
  claims: { userId: string; persona: AgentPersona; runId: string; ts?: number },
): string {
  if (!secret) throw new Error('AGENT_RUNTIME_SECRET is not set')
  const ts = claims.ts ?? Math.floor(Date.now() / 1000)
  const sig = mac(secret, claims.userId, claims.persona, claims.runId, ts)
  return [claims.userId, claims.persona, claims.runId, String(ts), sig].join(SEP)
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

/**
 * Verify a credential string. Returns the claims on success, or null on any
 * failure (bad shape, unknown persona, bad signature, outside the time window).
 */
export function verifyRuntimeCredential(
  secret: string,
  credential: string,
  opts?: { windowSec?: number; now?: () => number },
): RuntimeCredentialClaims | null {
  if (!secret || !credential) return null
  const parts = credential.split(SEP)
  if (parts.length !== 5) return null
  const [userId, persona, runId, tsStr, sig] = parts as [string, string, string, string, string]
  const p = agentPersonaSchema.safeParse(persona)
  if (!p.success) return null
  const ts = Number(tsStr)
  if (!Number.isInteger(ts)) return null
  const expected = mac(secret, userId, persona, runId, ts)
  if (!safeEqualHex(sig, expected)) return null
  const windowSec = opts?.windowSec ?? 300
  const nowSec = Math.floor((opts?.now ? opts.now() : Date.now()) / 1000)
  if (Math.abs(nowSec - ts) > windowSec) return null
  return { userId, persona: p.data, runId, ts }
}

/** Parse `Authorization: AMC-Runtime <credential>` -> the credential, or null. */
export function extractRuntimeCredential(authorizationHeader: string | null | undefined): string | null {
  if (!authorizationHeader) return null
  const m = /^AMC-Runtime\s+(.+)$/.exec(authorizationHeader.trim())
  return m ? (m[1] as string).trim() : null
}
