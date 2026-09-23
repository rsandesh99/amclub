import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestUser } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { getKycClient } from '@/lib/kyc'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { toGstinAutofill } from '@amclub/shared'

const bodySchema = z.object({
  gstin: z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, 'Invalid GSTIN format'),
})

export async function POST(request: NextRequest) {
  const user = await getRequestUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // E13 — Bearer is now accepted (the native wizard); a delegated agent token never is (S1.6: the agent never verifies or writes the profile).
  const delegated = await requireNotDelegated('profile/provider/kyc/verify-gstin')
  if (delegated) return delegated

  // Paid external API — strict per-user cap to prevent bill-drain.
  const rl = await enforce(limiters.kyc, `kyc:gstin:${user.id}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const kyc = getKycClient()
  const result = await kyc.verifyGstin(parsed.data.gstin)

  // S2.2 — record EVERY attempt (success or failure) server-side, mirroring
  // /kyc/verify-bank: the goods activation gate consumes this table, never a
  // client-sent flag. `result` stores GST-registry business facts only.
  const admin = await createAdminClient()
  const { error: recErr } = await admin.from('gstin_verifications').insert({
    user_id: user.id,
    gstin: parsed.data.gstin,
    verified: result.verified,
    stub: result.stub ?? false,
    provider: result.stub ? 'stub' : 'surepass',
    result: {
      legalName: result.legalName ?? null,
      tradeName: result.tradeName ?? null,
      state: result.state ?? null,
      registrationDate: result.registrationDate ?? null,
      isActive: result.isActive ?? null,
      statusText: result.statusText ?? null,
      error: result.error ?? null,
    },
  })
  if (recErr) console.error('[kyc/verify-gstin] could not record verification result:', recErr.message)

  if (!result.verified) {
    return NextResponse.json(
      { error: result.error ?? 'GSTIN verification failed', stub: result.stub },
      { status: 422 },
    )
  }

  return NextResponse.json({
    verified: true,
    legalName: result.legalName,
    tradeName: result.tradeName,
    stub: result.stub ?? false,
    // Experience v3 E10 (N27) — the vendor facts normalised for autofill: state from the vendor or the
    // GSTIN's own code (a disagreement is an admin flag, never a block), the date, active + its reason.
    autofill: toGstinAutofill(parsed.data.gstin, result),
  })
}
