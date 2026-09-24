import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireNotDelegated } from '@/lib/agent/scope'
import { z } from 'zod'
import { agentPersonaSchema, PERSONA_REQUIRED_ROLE, scopesWithinPersona, uuidSchema } from '@amclub/shared'
import { extractRuntimeCredential, verifyRuntimeCredential } from '@amclub/agent-core'
import { agentApiGate } from '@/lib/agent/gate'
import { activeGrant, mintDelegatedToken, userHasRoleForPersona } from '@/lib/agent/token'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { env } from '@/lib/env'

/**
 * POST /api/v1/agent/token — mint a ≤15-min, run-bound delegated JWT (ADR-008 §3,
 * ADR-009 §6). Two callers:
 *  - a SESSION (cookie/Bearer): persona must map to a role the user holds
 *    (PERSONA_REQUIRED_ROLE); scopes optional (⊆ persona allowlist).
 *  - the RUNTIME (`Authorization: AMC-Runtime <hmac>`): the HMAC is verified and
 *    an active agent_grants row for (user, persona) is REQUIRED; scopes come
 *    from the grant.
 * 404s while AGENT_ENABLED=false (agentApiGate). Rate limited per user.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const bodySchema = z.object({
  persona: agentPersonaSchema.optional(),
  scopes: z.array(z.string().min(1).max(60)).max(40).optional(),
  run_id: uuidSchema.optional(),
  ttl_sec: z.number().int().min(60).max(900).optional(),
})

export async function POST(request: NextRequest) {
  const gate = agentApiGate()
  if (gate) return gate

  const secret = env.SUPABASE_JWT_SECRET
  if (!secret) return NextResponse.json({ error: 'agent_not_configured' }, { status: 503 })

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const cred = extractRuntimeCredential(request.headers.get('authorization'))

  // ── runtime-credential path ──────────────────────────────────────────────
  if (cred) {
    const runtimeSecret = env.AGENT_RUNTIME_SECRET
    if (!runtimeSecret) return NextResponse.json({ error: 'agent_not_configured' }, { status: 503 })
    const claims = verifyRuntimeCredential(runtimeSecret, cred)
    if (!claims) return NextResponse.json({ error: 'invalid_runtime_credential' }, { status: 401 })
    const rl = await enforce(limiters.authed, `agent-token:${claims.userId}`)
    if (!rl.ok) return tooManyRequests(rl.retryAfter)
    const grant = await activeGrant(admin, claims.userId, claims.persona)
    if (!grant) return NextResponse.json({ error: 'no_active_grant' }, { status: 403 })
    const minted = mintDelegatedToken(
      {
        userId: claims.userId,
        persona: claims.persona,
        runId: claims.runId,
        scopes: grant.scopes,
        ...(parsed.data.ttl_sec !== undefined ? { ttlSec: parsed.data.ttl_sec } : {}),
      },
      secret,
    )
    return NextResponse.json(
      { token: minted.token, expires_at: minted.expiresAt, persona: claims.persona, run_id: claims.runId, scopes: minted.scopes ?? [] },
      { headers: NO_STORE },
    )
  }

  // ── session path ───────────────────────────────────────────────────────────
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Audit M3 — only a person's own session may mint here. A delegated token must
  // not renew itself, widen its scopes or re-bind to another run.
  const delegated = await requireNotDelegated('POST /agent/token (session)')
  if (delegated) return delegated
  const rl = await enforce(limiters.authed, `agent-token:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const persona = parsed.data.persona
  if (!persona) return NextResponse.json({ error: 'persona_required' }, { status: 422 })
  const requiredRole = PERSONA_REQUIRED_ROLE[persona]
  if (!(await userHasRoleForPersona(admin, userId, requiredRole))) {
    return NextResponse.json({ error: 'persona_not_permitted', persona, required_role: requiredRole }, { status: 403 })
  }
  if (parsed.data.scopes && !scopesWithinPersona(persona, parsed.data.scopes)) {
    return NextResponse.json({ error: 'scopes_exceed_persona' }, { status: 422 })
  }
  // A run id is bound only when that run is the caller's own.
  if (parsed.data.run_id) {
    const { data: run } = await admin.from('agent_runs').select('user_id').eq('id', parsed.data.run_id).maybeSingle()
    if (!run || run.user_id !== userId) return NextResponse.json({ error: 'run_not_yours' }, { status: 403 })
  }
  const minted = mintDelegatedToken(
    {
      userId,
      persona,
      runId: parsed.data.run_id ?? null,
      scopes: parsed.data.scopes ?? null,
      ...(parsed.data.ttl_sec !== undefined ? { ttlSec: parsed.data.ttl_sec } : {}),
    },
    secret,
  )
  return NextResponse.json(
    { token: minted.token, expires_at: minted.expiresAt, persona, run_id: parsed.data.run_id ?? null, scopes: minted.scopes ?? [] },
    { headers: NO_STORE },
  )
}
