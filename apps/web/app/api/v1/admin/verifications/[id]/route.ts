import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { serverError } from '@/lib/api/errors'

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

  // provider_profiles only carries status (active | rejected). Reviewer audit
  // metadata lives on provider_verifications, which has verified_by/verified_at/
  // rejection_reason columns.
  const newStatus = action === 'approve' ? 'active' : 'rejected'
  const { error: profileErr } = await admin
    .from('provider_profiles')
    .update({ status: newStatus })
    .eq('id', providerId)

  if (profileErr) {
    return serverError('[admin/verifications POST] profile update:', profileErr)
  }

  // Stamp reviewer + outcome on the provider's verification rows.
  // Verification status enum: pending | api_verified | manually_approved | rejected.
  const { error: verErr } = await admin
    .from('provider_verifications')
    .update({
      status: action === 'approve' ? 'manually_approved' : 'rejected',
      verified_by: user.id,
      verified_at: new Date().toISOString(),
      rejection_reason: action === 'reject' ? (reason ?? null) : null,
    })
    .eq('provider_id', providerId)

  if (verErr) {
    console.error('[admin/verifications POST] verification update:', verErr)
    // Non-fatal — provider_profiles.status is the source of truth
  }

  // Audit log — Phase 6 will wire real notifications
  if (action === 'approve') {
    console.warn(`[admin/verifications] Provider ${providerId} approved by ${user.id}`)
  } else {
    console.warn(
      `[admin/verifications] Provider ${providerId} rejected by ${user.id}: ${reason}`,
    )
  }

  return NextResponse.json({ success: true, status: newStatus })
}
