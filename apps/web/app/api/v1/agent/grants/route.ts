import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { agentGrantSchema } from '@amclub/shared'
import { agentApiGate } from '@/lib/agent/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests, clientIp } from '@/lib/rate-limit'
import { requireNotDelegated } from '@/lib/agent/scope'

/**
 * Delegation grants (ADR-009 §6). A user grants an agent persona + scopes on a
 * channel, with a consent snapshot; the token endpoint refuses a runtime
 * credential without an active grant. Reads run under the user's own session
 * (RLS self read). Writes are the user's own session only (requireNotDelegated),
 * then the service role (0085: no client role writes agent_grants — a delegated
 * token is role=authenticated and could otherwise widen its own scopes or forge
 * a consent). 404s while AGENT_ENABLED=false.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET() {
  const gate = agentApiGate()
  if (gate) return gate
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data, error } = await supabase
    .from('agent_grants')
    .select('id, persona, scopes, channel, channel_identity, created_at, revoked_at')
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ grants: data ?? [] }, { headers: NO_STORE })
}

export async function POST(request: NextRequest) {
  const gate = agentApiGate()
  if (gate) return gate
  // Audit wave 3: no agent tool wraps this route, so a delegated agent token is refused.
  const delegated = await requireNotDelegated('POST /agent/grants')
  if (delegated) return delegated
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const rl = await enforce(limiters.authed, `agent-grant:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const parsed = agentGrantSchema.safeParse(raw)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const consent = {
    locale: typeof raw?.['locale'] === 'string' ? raw['locale'] : 'en',
    surface: typeof raw?.['surface'] === 'string' ? raw['surface'] : 'web',
    text_version: typeof raw?.['consent_text_version'] === 'string' ? raw['consent_text_version'] : 'v1',
    ip: clientIp(request),
    user_agent: request.headers.get('user-agent') ?? null,
    at: new Date().toISOString(),
  }

  // A persona the user does not hold is not theirs to grant (the audit's low #12): buyer ⇐ msme, provider ⇐ provider,
  // ops ⇐ admin | ops. A WhatsApp grant is consent FROM a phone, so its identity is the user's own number, never the body's.
  const admin = await createAdminClient()
  const { data: me } = await admin.from('users').select('roles, phone').eq('id', userId).maybeSingle()
  const roles = ((me as { roles?: string[] | null } | null)?.roles ?? []) as string[]
  const persona = parsed.data.persona
  const holds = persona === 'buyer' ? roles.includes('msme') : persona === 'provider' ? roles.includes('provider') : roles.includes('admin') || roles.includes('ops')
  if (!holds) return NextResponse.json({ error: 'persona_not_held' }, { status: 403, headers: NO_STORE })
  let channelIdentity: string | null = null
  if (parsed.data.channel === 'whatsapp') {
    const digits = String((me as { phone?: string | null } | null)?.phone ?? '').replace(/\D/g, '')
    if (!digits) return NextResponse.json({ error: 'phone_required' }, { status: 422, headers: NO_STORE })
    channelIdentity = `+${digits}`
  }

  const insert = {
    user_id: userId,
    persona,
    scopes: parsed.data.scopes,
    channel: parsed.data.channel,
    channel_identity: channelIdentity,
    consent,
  }
  // Grants are immutable except revoke (the agent_grants_immutable trigger). To refresh scopes we revoke any active
  // grant on the same (user, persona, channel) then insert a new one — keeping the active-grant partial unique index
  // satisfied and at most one active grant.
  await admin
    .from('agent_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('persona', persona)
    .eq('channel', parsed.data.channel)
    .is('revoked_at', null)
  const { data, error } = await admin
    .from('agent_grants')
    .insert(insert)
    .select('id, persona, scopes, channel, channel_identity, created_at')
    .single()
  if (error) {
    console.error('[agent/grants] insert failed', error.message)
    return NextResponse.json({ error: 'grant_failed' }, { status: 500, headers: NO_STORE })
  }
  return NextResponse.json({ grant: data }, { status: 201, headers: NO_STORE })
}

export async function DELETE(request: NextRequest) {
  const gate = agentApiGate()
  if (gate) return gate
  // Audit wave 3: no agent tool wraps this route, so a delegated agent token is refused.
  const delegated = await requireNotDelegated('DELETE /agent/grants')
  if (delegated) return delegated
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const id = request.nextUrl.searchParams.get('id')
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'id_required' }, { status: 422 })
  // Revoke only the caller's own active grant (service role after the ownership filter; 0085 withdrew the client write).
  const admin = await createAdminClient()
  const { data, error } = await admin
    .from('agent_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .is('revoked_at', null)
    .select('id')
  if (error) {
    console.error('[agent/grants] revoke failed', error.message)
    return NextResponse.json({ error: 'revoke_failed' }, { status: 500, headers: NO_STORE })
  }
  if (!data || data.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE })
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
