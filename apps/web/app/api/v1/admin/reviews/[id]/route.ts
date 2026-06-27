import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { serverError } from '@/lib/api/errors'

const bodySchema = z.object({ action: z.enum(['remove', 'restore']) })

/** POST — ops moderates a flagged review: remove (hide) or restore (publish). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!user.roles.includes('admin') && !user.roles.includes('ops')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await params
  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const newStatus = parsed.data.action === 'remove' ? 'removed' : 'published'
  const admin = await createAdminClient()
  const { data: before } = await admin.from('reviews').select('status').eq('id', id).maybeSingle()
  if (!before) return NextResponse.json({ error: 'Review not found' }, { status: 404 })

  const { error } = await admin
    .from('reviews')
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) return serverError('[admin/reviews POST]', error)

  // The reviews_recompute_rating trigger updates the provider's avg + count.
  await admin.from('audit_logs').insert({
    actor_id: user.id,
    action: parsed.data.action === 'remove' ? 'review_removed' : 'review_restored',
    entity: 'reviews',
    entity_id: id,
    before: { status: before.status },
    after: { status: newStatus },
  })

  return NextResponse.json({ ok: true, status: newStatus })
}
