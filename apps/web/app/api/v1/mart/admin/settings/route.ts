import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { MART_SETTING_DEFS, MART_SETTING_KEYS, martSettingPutSchema, parseMartSetting } from '@amclub/shared'
import { martApiGate } from '@/lib/mart/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { listMartSettings } from '@/lib/mart/config'
import { writeAudit, stableEntityId } from '@/lib/audit/log'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Launch Gate — founder decisions (§9) as config. GET lists every registry key
 * with its stored value (or null when unset) and the decision it encodes; PUT
 * writes ONE key after per-key Zod validation (closed registry, audited).
 */
export async function GET() {
  const gate = martApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const admin = await createAdminClient()
  const rows = await listMartSettings(admin)
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const settings = MART_SETTING_KEYS.map((key) => {
    const row = byKey.get(key)
    const def = MART_SETTING_DEFS[key]
    return { key, value: row?.value ?? null, set: !!row, updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null, decision: def.decision, hint: def.hint }
  })
  const unknown = rows.filter((r) => !(MART_SETTING_KEYS as string[]).includes(r.key)).map((r) => r.key)
  return NextResponse.json({ settings, unknown }, { headers: NO_STORE })
}

export async function PUT(request: NextRequest) {
  const gate = martApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const rl = await enforce(limiters.adminMutation, `admin:${auth.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const parsed = martSettingPutSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const checked = parseMartSetting(parsed.data.key, parsed.data.value)
  if (!checked.ok) return NextResponse.json({ error: 'invalid_value', detail: checked.error }, { status: 422 })

  const admin = await createAdminClient()
  const { data: before } = await admin.from('mart_settings').select('value').eq('key', checked.key).maybeSingle()
  const now = new Date().toISOString()
  const { error } = await admin
    .from('mart_settings')
    .upsert({ key: checked.key, value: checked.value as never, updated_by: auth.userId, updated_at: now }, { onConflict: 'key' })
  if (error) return serverError('[mart/admin/settings PUT]', error)
  await writeAudit(admin, request, {
    actorId: auth.userId,
    action: 'mart_setting_update',
    entity: 'mart_settings',
    entityId: stableEntityId('mart_settings', checked.key),
    before: { key: checked.key, value: before?.value ?? null },
    after: { key: checked.key, value: checked.value },
  })
  return NextResponse.json({ key: checked.key, value: checked.value, updated_at: now }, { headers: NO_STORE })
}
