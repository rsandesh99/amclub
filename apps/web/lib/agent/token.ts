import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentPersona } from '@amclub/shared'
import { signHs256 } from './jwt'

/**
 * Delegated-identity token minting (ADR-008 §3, ADR-009 §6). A ≤15-min,
 * run-bound JWT signed with SUPABASE_JWT_SECRET so the runtime acts as the user
 * under RLS — never the service role for user data. The route decides the
 * caller path (session vs runtime credential); these helpers are pure.
 */

export const MAX_TOKEN_TTL_SEC = 900 // 15 minutes (ADR-008 §3)

export interface MintInput {
  userId: string
  persona: AgentPersona
  runId?: string | null
  /** Least-privilege scopes; omitted => no amc_scopes claim (full persona). */
  scopes?: string[] | null
  ttlSec?: number
}

export interface MintedToken {
  token: string
  expiresAt: string
  scopes: string[] | null
}

export function mintDelegatedToken(input: MintInput, secret: string): MintedToken {
  if (!secret) throw new Error('SUPABASE_JWT_SECRET is not set')
  const now = Math.floor(Date.now() / 1000)
  const ttl = Math.min(Math.max(60, input.ttlSec ?? MAX_TOKEN_TTL_SEC), MAX_TOKEN_TTL_SEC)
  const exp = now + ttl
  const payload: Record<string, unknown> = {
    sub: input.userId,
    role: 'authenticated',
    aud: 'authenticated',
    iat: now,
    exp,
    amc_persona: input.persona,
  }
  if (input.runId) payload['amc_run_id'] = input.runId
  const scopes = input.scopes && input.scopes.length > 0 ? input.scopes : null
  if (scopes) payload['amc_scopes'] = scopes
  return { token: signHs256(payload, secret), expiresAt: new Date(exp * 1000).toISOString(), scopes }
}

/** The role a persona requires — for the session path. */
export async function userHasRoleForPersona(admin: SupabaseClient, userId: string, requiredRole: string): Promise<boolean> {
  const { data } = await admin.from('users').select('roles').eq('id', userId).maybeSingle()
  const roles = ((data?.roles as string[] | null) ?? [])
  return roles.includes(requiredRole)
}

/** The active (non-revoked) grant for (user, persona), or null — the runtime path. */
export async function activeGrant(
  admin: SupabaseClient,
  userId: string,
  persona: AgentPersona,
): Promise<{ id: string; scopes: string[]; channel: string } | null> {
  const { data } = await admin
    .from('agent_grants')
    .select('id, scopes, channel')
    .eq('user_id', userId)
    .eq('persona', persona)
    .is('revoked_at', null)
    .limit(1)
    .maybeSingle()
  if (!data) return null
  const r = data as { id: string; scopes: string[] | null; channel: string }
  return { id: r.id, scopes: r.scopes ?? [], channel: r.channel }
}
