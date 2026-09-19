import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { agentGrantSchema } from '@amclub/shared'
import { agentApiGate } from '@/lib/agent/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { enforce, limiters, tooManyRequests, clientIp } from '@/lib/rate-limit'

/**
 * Delegation grants (ADR-009 §6). A user grants an agent persona + scopes on a
 * channel, with a consent snapshot; the token endpoint refuses a runtime
 * credential without an active grant. All operations run under the user's OWN
 * session (RLS self read/insert/revoke) — never the service role.
 * 404s while AGENT_ENABLED=false.
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
  const { supabase, userId } = await getAuthedSupabase()
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

  const insert = {
    user_id: userId,
    persona: parsed.data.persona,
    scopes: parsed.data.scopes,
    channel: parsed.data.channel,
    channel_identity: parsed.data.channel_identity ?? null,
    consent,
  }
  // Grants are immutable except revoke (the self-revoke policy grants only the
  // revoked_at column). To refresh scopes we revoke any active grant on the same
  // (user, persona, channel) then insert a new one — keeping the active-grant
  // partial unique index satisfied and at most one active grant.
  await supabase
    .from('agent_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('persona', parsed.data.persona)
    .eq('channel', parsed.data.channel)
    .is('revoked_at', null)
  const { data, error } = await supabase
    .from('agent_grants')
    .insert(insert)
    .select('id, persona, scopes, channel, channel_identity, created_at')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ grant: data }, { status: 201, headers: NO_STORE })
}

export async function DELETE(request: NextRequest) {
  const gate = agentApiGate()
  if (gate) return gate
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const id = request.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id_required' }, { status: 422 })
  // Column-scoped UPDATE (revoked_at only) under the self-revoke RLS policy.
  const { error } = await supabase.from('agent_grants').update({ revoked_at: new Date().toISOString() }).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
