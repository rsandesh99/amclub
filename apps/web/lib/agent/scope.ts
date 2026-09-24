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
export async function requireToolScope(tool: AgentToolName | readonly AgentToolName[]): Promise<NextResponse | null> {
  const claims = await bearerClaims()
  const scopes = claims?.['amc_scopes']
  // No scope claim => ordinary session (or a full-persona delegated token): allow.
  if (!Array.isArray(scopes)) return null
  // S2.3 — a route several tools wrap (an RFQ read: extract_requirements for Munshi, support_lookup for Support) accepts any of them.
  const tools = Array.isArray(tool) ? tool : [tool as AgentToolName]
  if (!tools.some((t) => scopes.includes(t))) {
    return NextResponse.json({ error: 'tool_out_of_scope', tool: tools[0] }, { status: 403 })
  }
  return null
}

/**
 * S1.4 — routes NO tool wraps (admin mutations such as the payout release).
 * ANY delegated token (one carrying `amc_persona`, scoped or full-persona) is
 * refused with the same 403 shape, so an agent can never reach them even under
 * an admin's own grant. Ordinary sessions (no `amc_persona` claim) pass.
 */
export async function requireNotDelegated(route: string): Promise<NextResponse | null> {
  const claims = await bearerClaims()
  if (!claims) return null
  if (typeof claims['amc_persona'] === 'string' || Array.isArray(claims['amc_scopes'])) {
    return NextResponse.json({ error: 'tool_out_of_scope', tool: null, route }, { status: 403 })
  }
  return null
}

/** True when the caller holds a delegated agent token (`amc_persona` or `amc_scopes`), not a person's session. */
export async function isDelegated(): Promise<boolean> {
  const claims = await bearerClaims()
  return !!claims && (typeof claims['amc_persona'] === 'string' || Array.isArray(claims['amc_scopes']))
}

/** S2.2 — the run a delegated token is bound to (`amc_run_id`), or null for an ordinary session. */
export async function delegatedRunId(): Promise<string | null> {
  const claims = await bearerClaims()
  const v = claims?.['amc_run_id']
  return typeof v === 'string' && v.length > 0 ? v : null
}

async function bearerClaims(): Promise<Record<string, unknown> | null> {
  const h = await headers()
  const authz = h.get('authorization')
  if (!authz?.startsWith('Bearer ')) return null
  return decodeJwtClaims(authz.slice(7))
}
