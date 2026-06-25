import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'

const bodySchema = z.object({
  action: z.enum(['approve', 'reject']),
  reason: z.string().max(1000).optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const isAdminOrOps =
    user.roles.includes('admin') || user.roles.includes('ops')
  if (!isAdminOrOps) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id: providerId } = await params

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { action, reason } = parsed.data

  if (action === 'reject' && !reason?.trim()) {
    return NextResponse.json({ error: 'Reject reason is required' }, { status: 422 })
  }

  const admin = await createAdminClient()

  // Update provider_profiles status
  const newStatus = action === 'approve' ? 'active' : 'rejected'
  const { error: profileErr } = await admin
    .from('provider_profiles')
    .update({
      status: newStatus,
      reviewed_at: new Date().toISOString(),
      reviewed_by: user.id,
      rejection_reason: action === 'reject' ? reason : null,
    })
    .eq('id', providerId)

  if (profileErr) {
    console.error('[admin/verifications POST] profile update:', profileErr)
    return NextResponse.json({ error: profileErr.message }, { status: 500 })
  }

  // Update provider_verifications status
  const { error: verErr } = await admin
    .from('provider_verifications')
    .update({ status: action === 'approve' ? 'approved' : 'rejected' })
    .eq('provider_id', providerId)

  if (verErr) {
    console.error('[admin/verifications POST] verification update:', verErr)
    // Non-fatal — profile is the source of truth
  }

  // If approving, notify provider (placeholder — Phase 6 will wire notifications)
  if (action === 'approve') {
    console.log(`[admin/verifications] Provider ${providerId} approved by ${user.id}`)
  } else {
    console.log(
      `[admin/verifications] Provider ${providerId} rejected by ${user.id}: ${reason}`,
    )
  }

  return NextResponse.json({ success: true, status: newStatus })
}
