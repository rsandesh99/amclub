import 'server-only'
import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import type { AgentToolName } from '@amclub/shared'
import { decodeJwtClaims } from './jwt'

/**
 * Per-tool scope enforcement on the routes the agent tools wrap (ADR-009 §6).
 *
 * A delegated token minted for a runtime agent carries `amc_scopes` (from the
 * grant). requireToolScope reads those claims (the token was already validated
 * by Supabase upstream when the route resolved the user) and 403s when the
 * token carries scopes and THIS tool is not among them. An ORDINARY session
 * carries no `amc_scopes` claim, so this is a no-op for every human caller —
 * zero behaviour change for existing traffic.
 */
export async function requireToolScope(tool: AgentToolName): Promise<NextResponse | null> {
  const h = await headers()
  const authz = h.get('authorization')
  if (!authz?.startsWith('Bearer ')) return null
  const claims = decodeJwtClaims(authz.slice(7))
  const scopes = claims?.['amc_scopes']
  // No scope claim => ordinary session (or a full-persona delegated token): allow.
  if (!Array.isArray(scopes)) return null
  if (!scopes.includes(tool)) {
    return NextResponse.json({ error: 'tool_out_of_scope', tool }, { status: 403 })
  }
  return null
}
