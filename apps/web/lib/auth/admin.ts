import 'server-only'
import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import type { AgentToolName } from '@amclub/shared'
import { isDelegated, requireToolScope } from '@/lib/agent/scope'

/**
 * Admin/ops gate that works for BOTH web (cookie) and mobile/programmatic
 * (Authorization: Bearer) callers — unlike getSessionUser(), which is
 * cookie-only. Resolves the caller's roles via the service-role client.
 * Returns the user id on success, or a ready-to-return error response.
 */
export async function requireAdmin(opts?: { agentTool?: AgentToolName }): Promise<
  { userId: string; error?: undefined } | { userId?: undefined; error: NextResponse }
> {
  const { userId } = await getAuthedSupabase()
  if (!userId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const admin = await createAdminClient()
  const { data: user } = await admin.from('users').select('roles').eq('id', userId).maybeSingle()
  const roles = user?.roles ?? []
  if (!roles.includes('admin') && !roles.includes('ops')) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  // Audit M7 — a delegated agent token is refused on every admin route except
  // the read-only ops tools that name themselves here (AGENT_TOOLS), and then
  // only with that tool in the token's scope. Admin mutations are never tools.
  if (await isDelegated()) {
    if (!opts?.agentTool) return { error: NextResponse.json({ error: 'tool_out_of_scope', tool: null, route: 'admin' }, { status: 403 }) }
    const scope = await requireToolScope(opts.agentTool)
    if (scope) return { error: scope }
  }
  return { userId }
}
