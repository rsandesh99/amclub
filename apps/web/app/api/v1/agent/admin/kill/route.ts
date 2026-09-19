import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { killSwitchAgentsEnabled } from '@amclub/shared'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { getAgentsEnabled } from '@/lib/agent/settings'
import { writeAudit, stableEntityId } from '@/lib/audit/log'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'

/**
 * Kill switch (S0.2, ADR-009 §7) — one tap sets agents_enabled to all-false,
 * disabling every agent instantly (the cohort allowlist and per-key budgets are
 * left intact so re-enabling is a deliberate flip, not an accident). Audited.
 * Admin/ops only; agentApiGate first.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const rl = await enforce(limiters.adminMutation, `admin:${auth.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const admin = await createAdminClient()
  const before = await getAgentsEnabled(admin)
  const allOff = killSwitchAgentsEnabled()
  const now = new Date().toISOString()
  const { error } = await admin
    .from('agent_settings')
    .upsert({ key: 'agents_enabled', value: allOff as never, updated_by: auth.userId, updated_at: now }, { onConflict: 'key' })
  if (error) return serverError('[agent/admin/kill]', error)
  await writeAudit(admin, request, {
    actorId: auth.userId,
    action: 'agent_kill_switch',
    entity: 'agent_settings',
    entityId: stableEntityId('agent_settings', 'agents_enabled'),
    before: { agents_enabled: before },
    after: { agents_enabled: allOff },
  })
  return NextResponse.json({ ok: true, agents_enabled: allOff, at: now }, { headers: { 'Cache-Control': 'private, no-store' } })
}
