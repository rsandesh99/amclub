import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { PROVIDER_REVIEWABLE_STATUSES, type ProviderStatus } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { requireNotDelegated } from '@/lib/agent/scope'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'
import { writeAudit } from '@/lib/audit/log'
import { revalidateProviderCatalog } from '@/lib/catalog/revalidate'
import { getProviderReadiness } from '@/lib/payments/readiness-server'
import { notifyVerificationDecision } from '@/lib/notifications/events'

/**
 * approve / reject decide a pending application; needs_info (ADR-030 §4) keeps it pending and tells the provider
 * what is missing (the reason is required, like a rejection's). Every decision notifies the provider (the signup
 * copy promises it) and is audit-logged.
 */
const bodySchema = z.object({
  action: z.enum(['approve', 'reject', 'needs_info']),
  reason: z.string().max(1000).optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // S1.5 — same gate as every other admin route: requireAdmin accepts BOTH the
  // admin browser cookie session and Bearer callers, and resolves roles via
  // the service-role client. Plus the standard admin-mutation rate limit.
  const gate = await requireAdmin()
  if (gate.error) return gate.error
  // Audit M11 — KYC approval gates who can receive money: never an agent tool.
  const delegated = await requireNotDelegated('POST /admin/verifications/[id]')
  if (delegated) return delegated

  const rl = await enforce(limiters.adminMutation, `admin:${gate.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const { id: providerId } = await params

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { action, reason } = parsed.data

  if ((action === 'reject' || action === 'needs_info') && !reason?.trim()) {
    return NextResponse.json({ error: 'Reject reason is required' }, { status: 422 })
  }

  const admin = await createAdminClient()

  // Audit M11 — only a pending application is decided here. An active or
  // suspended provider changes only through the audited suspend / reactivate
  // actions (/admin/providers/[id]); approving a suspended provider from this
  // queue would have reactivated them with no record.
  const { data: before } = await admin.from('provider_profiles').select('id, status').eq('id', providerId).maybeSingle()
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const fromStatus = before.status as ProviderStatus
  if (!PROVIDER_REVIEWABLE_STATUSES.includes(fromStatus)) {
    return NextResponse.json({ error: 'not_pending', code: 'not_pending', status: fromStatus }, { status: 409 })
  }

  // needs_info: the application stays pending; the provider hears what to add. Nothing else changes.
  if (action === 'needs_info') {
    await writeAudit(admin, request, {
      actorId: gate.userId,
      action: 'provider_verification_needs_info',
      entity: 'provider_profiles',
      entityId: providerId,
      before: { status: fromStatus },
      after: { status: fromStatus, reason: reason ?? null },
    })
    try {
      await notifyVerificationDecision(admin, providerId, 'needs_info', reason)
    } catch (e) {
      console.error('[admin/verifications POST] notify:', e)
    }
    return NextResponse.json({ success: true, status: fromStatus })
  }

  // provider_profiles only carries status (active | rejected). Reviewer audit
  // metadata lives on provider_verifications, which has verified_by/verified_at/
  // rejection_reason columns. Compare-and-set on the pending status: a second
  // reviewer (or a suspend) that lands first wins, and this decision is refused.
  const newStatus: ProviderStatus = action === 'approve' ? 'active' : 'rejected'
  const { data: moved, error: profileErr } = await admin
    .from('provider_profiles')
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', providerId)
    .in('status', [...PROVIDER_REVIEWABLE_STATUSES])
    .select('id')

  if (profileErr) {
    return serverError('[admin/verifications POST] profile update:', profileErr)
  }
  if (!moved?.length) return NextResponse.json({ error: 'not_pending', code: 'not_pending' }, { status: 409 })

  // Stamp reviewer + outcome on the provider's verification rows.
  // Verification status enum: pending | api_verified | manually_approved | rejected.
  const { data: stamped, error: verErr } = await admin
    .from('provider_verifications')
    .update({
      status: action === 'approve' ? 'manually_approved' : 'rejected',
      verified_by: gate.userId,
      verified_at: new Date().toISOString(),
      rejection_reason: action === 'reject' ? (reason ?? null) : null,
    })
    .eq('provider_id', providerId)
    .select('kind')

  if (verErr) {
    console.error('[admin/verifications POST] verification update:', verErr)
    // Non-fatal — provider_profiles.status is the source of truth
  }

  // §7 — every admin mutation is audit-logged, with the status it left.
  await writeAudit(admin, request, {
    actorId: gate.userId,
    action: `provider_verification_${action}`,
    entity: 'provider_profiles',
    entityId: providerId,
    before: { status: fromStatus },
    after: {
      status: newStatus,
      ...(action === 'reject' ? { reason: reason ?? null } : {}),
      verifications: ((stamped ?? []) as { kind: string }[]).map((v) => v.kind),
    },
  })

  // Approval/rejection flips public visibility — purge the ISR cache NOW so
  // the provider's pages appear (or vanish) in seconds, not after the ISR
  // window (C6: approvals previously served the cached 404 for up to 1h).
  try {
    await revalidateProviderCatalog(admin, providerId)
  } catch (e) {
    console.error('[admin/verifications POST] cache purge:', e)
  }

  // Phase 3b (option ii): approval never waits on Razorpay paperwork, but the
  // approver must see — at the moment of approval — that payouts will hold
  // until the Route account is linked / bank verified. The same fact drives
  // the admin dashboard "Payout-ready" tile, so it is the founder's checklist
  // item from this instant, not something waiting on the provider.
  const { readiness } = await getProviderReadiness(admin, providerId)
  // ADR-030 §4 — the provider hears the decision (the signup copy promises it), with the reason on a rejection.
  try {
    await notifyVerificationDecision(admin, providerId, action, action === 'reject' ? reason : null)
  } catch (e) {
    console.error('[admin/verifications POST] notify:', e)
  }
  if (action === 'approve') {
    console.warn(`[admin/verifications] Provider ${providerId} approved by ${gate.userId} — payout readiness: ${readiness}`)
  } else {
    console.warn(
      `[admin/verifications] Provider ${providerId} rejected by ${gate.userId}: ${reason}`,
    )
  }

  return NextResponse.json({ success: true, status: newStatus, readiness })
}
