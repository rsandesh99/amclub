import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'

/** GET — searchable audit log (§7). Filter by action, entity, actorId, date range. */
export async function GET(request: NextRequest) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const sp = new URL(request.url).searchParams
  const admin = await createAdminClient()
  let query = admin
    .from('audit_logs')
    .select('id, actor_id, action, entity, entity_id, before, after, ip, created_at, actor:users(email, full_name)')
    .order('created_at', { ascending: false })
    .limit(200)

  const action = sp.get('action')
  const entity = sp.get('entity')
  const actorId = sp.get('actorId')
  const from = sp.get('from')
  const to = sp.get('to')
  if (action) query = query.ilike('action', `%${action}%`)
  if (entity) query = query.eq('entity', entity)
  if (actorId) query = query.eq('actor_id', actorId)
  if (from) query = query.gte('created_at', from)
  if (to) query = query.lte('created_at', to)

  const { data } = await query
  return NextResponse.json({ logs: data ?? [] })
}
