import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { writeAudit } from '@/lib/audit/log'
import { resolveDispute } from '@/lib/disputes/resolve'
import { serverError } from '@/lib/api/errors'

const bodySchema = z
  .object({
    resolution: z.enum(['refund_full', 'refund_partial', 'release']),
    amountPaise: z.number().int().nonnegative().optional(),
  })
  .refine((d) => d.resolution !== 'refund_partial' || (d.amountPaise != null && d.amountPaise > 0), {
    message: 'refund_partial requires a positive amountPaise',
    path: ['amountPaise'],
  })

/** POST — ops resolves a dispute (§5.4/§9.2). Money moves via the proven refund
 *  + payout rails; idempotent; audit-logged. */
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
  const { data: before } = await admin.from('disputes').select('status, resolution').eq('id', id).maybeSingle()

  let result
  try {
    result = await resolveDispute(admin, id, parsed.data.resolution, parsed.data.amountPaise, gate.userId)
  } catch (e) {
    return serverError('[dispute resolve]', e)
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status ?? 400 })

  // Audit only a real state change (idempotent re-resolves don't move money).
  if (!result.already) {
    await writeAudit(admin, request, {
      actorId: gate.userId,
      action: `dispute_${parsed.data.resolution}`,
      entity: 'disputes',
      entityId: id,
      before,
      after: { status: 'resolved', resolution: parsed.data.resolution, refund_paise: result.refundPaise, provider_paid_paise: result.providerPaidPaise },
    })
  }

  return NextResponse.json(result)
}
