import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { writeAudit } from '@/lib/audit/log'
import { serverError } from '@/lib/api/errors'

/** GET — MSME detail: profile + order history. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const { id } = await params
  const admin = await createAdminClient()
  const { data: msme } = await admin.from('msme_profiles').select('*').eq('id', id).maybeSingle()
  if (!msme) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: orders } = await admin
    .from('orders')
    .select('id, order_number, status, total_paise, created_at')
    .eq('msme_id', id)
    .order('created_at', { ascending: false })
    .limit(50)

  return NextResponse.json({ msme, orders: orders ?? [] })
}

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('suspend'), reason: z.string().trim().min(1).max(1000) }),
  z.object({ action: z.literal('reactivate') }),
])

/** POST — suspend (soft-delete) / reactivate an MSME. Audit-logged. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const rl = await enforce(limiters.adminMutation, `admin:${gate.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const { id } = await params
  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const { data: before } = await admin.from('msme_profiles').select('deleted_at').eq('id', id).maybeSingle()
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const deletedAt = parsed.data.action === 'suspend' ? new Date().toISOString() : null
  try {
    await admin.from('msme_profiles').update({ deleted_at: deletedAt, updated_at: new Date().toISOString() }).eq('id', id)
  } catch (e) {
    return serverError('[admin/msmes action]', e)
  }

  await writeAudit(admin, request, {
    actorId: gate.userId,
    action: `msme_${parsed.data.action}`,
    entity: 'msme_profiles',
    entityId: id,
    before,
    after: { deleted_at: deletedAt, ...(parsed.data.action === 'suspend' ? { reason: parsed.data.reason } : {}) },
  })

  return NextResponse.json({ ok: true })
}
