import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { agentSettingPutSchema, parseAgentSetting } from '@amclub/shared'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { listAgentSettings } from '@/lib/agent/settings'
import { writeAudit, stableEntityId } from '@/lib/audit/log'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'

/**
 * Agent config registry editor (S0.2) — mirrors mart/admin/settings exactly.
 * GET lists every registry key with its stored value (or the launch default)
 * and its hint; PUT writes ONE key after per-key Zod validation (closed
 * registry, audited). Admin/ops only; agentApiGate first (404 when dark).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET() {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const admin = await createAdminClient()
  const { settings, unknown } = await listAgentSettings(admin)
  return NextResponse.json({ settings, unknown }, { headers: NO_STORE })
}

export async function PUT(request: NextRequest) {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const rl = await enforce(limiters.adminMutation, `admin:${auth.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const parsed = agentSettingPutSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const checked = parseAgentSetting(parsed.data.key, parsed.data.value)
  if (!checked.ok) return NextResponse.json({ error: 'invalid_value', detail: checked.error }, { status: 422 })

  const admin = await createAdminClient()
  const { data: before } = await admin.from('agent_settings').select('value').eq('key', checked.key).maybeSingle()
  const now = new Date().toISOString()
  const { error } = await admin
    .from('agent_settings')
    .upsert({ key: checked.key, value: checked.value as never, updated_by: auth.userId, updated_at: now }, { onConflict: 'key' })
  if (error) return serverError('[agent/admin/settings PUT]', error)
  await writeAudit(admin, request, {
    actorId: auth.userId,
    action: 'agent_setting_update',
    entity: 'agent_settings',
    entityId: stableEntityId('agent_settings', checked.key),
    before: { key: checked.key, value: before?.value ?? null },
    after: { key: checked.key, value: checked.value },
  })
  return NextResponse.json({ key: checked.key, value: checked.value, updated_at: now }, { headers: NO_STORE })
}
